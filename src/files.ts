import type { Env } from "./index";
import { NOTES_FILE, fail, filesPrefix, findProject, limits, ok, type ProjectRow, type ToolResult } from "./project";
import { formatBytes, sleep, toInt, validatePath } from "./util";

const enc = new TextEncoder();
const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 30000;
const LIST_LIMIT = 300;
const MAX_BATCH_FILES = 20;
const MAX_RETRIES = 6;

type FileMeta = { version: number; size: number };
type State = { total_bytes: number; file_count: number };
type WriteResult = { ok: true; version: number; size: number } | { ok: false; error: string; conflict?: boolean };
type ReadResult = { ok: true; meta: FileMeta; text: string } | { ok: false; error: string };

// ---------- helpers ----------

/** D1 row is the source of truth for versions. Phase-1 projects had NOTES.md without a row: adopt it as v1. */
async function getMeta(env: Env, id: string, path: string): Promise<FileMeta | null> {
  const r = await env.DB.prepare("SELECT version, size FROM files WHERE project_id = ? AND path = ?")
    .bind(id, path)
    .first<FileMeta>();
  if (r) return r;
  const h = await env.FILES.head(filesPrefix(id) + path);
  if (!h) return null;
  await env.DB.prepare("INSERT OR IGNORE INTO files (project_id, path, version, size, updated_at) VALUES (?, ?, 1, ?, ?)")
    .bind(id, path, h.size, Date.now())
    .run();
  return { version: 1, size: h.size };
}

/** Reads content and checks it matches the D1 version (a write may be in flight). */
async function readConsistent(env: Env, id: string, path: string): Promise<ReadResult> {
  for (let i = 0; i < 6; i++) {
    const meta = await getMeta(env, id, path);
    if (!meta) return { ok: false, error: `File not found: ${path}. Use file_list to see files.` };
    const obj = await env.FILES.get(filesPrefix(id) + path);
    if (!obj) return { ok: false, error: `File not found: ${path}. Use file_list to see files.` };
    const v = obj.customMetadata?.v;
    if ((v === undefined && meta.version === 1) || v === String(meta.version)) return { ok: true, meta, text: await obj.text() };
    await sleep(40);
  }
  return { ok: false, error: "File is being updated by another write. Retry in a moment." };
}

async function writeFile(
  env: Env,
  id: string,
  state: State,
  path: string,
  content: string,
  baseVersion: number | undefined
): Promise<WriteResult> {
  const lim = limits(env);
  const bytes = enc.encode(content).length;
  if (content.includes("\u0000")) return { ok: false, error: "Binary content is not supported (text files only)." };
  if (bytes > lim.maxFileBytes) return { ok: false, error: `File too large (${formatBytes(bytes)}). Max ${formatBytes(lim.maxFileBytes)} per file. Split it into smaller files.` };

  const meta = await getMeta(env, id, path);
  const now = Date.now();
  let newVersion: number;
  let dfc = 0;

  if (meta) {
    if (baseVersion === undefined)
      return { ok: false, conflict: true, error: `${path} already exists (version ${meta.version}). Pass base_version=${meta.version} to overwrite it, or use file_edit for small changes.` };
    if (baseVersion !== meta.version)
      return { ok: false, conflict: true, error: `Version conflict on ${path}: current version is ${meta.version}, you sent ${baseVersion}. Re-read it with file_read and merge your changes.` };
    if (state.total_bytes - meta.size + bytes > lim.maxBytes)
      return { ok: false, error: `Project size limit reached (${formatBytes(lim.maxBytes)}). Delete or shrink files first.` };
    const r = await env.DB.prepare(
      "UPDATE files SET version = version + 1, size = ?, updated_at = ? WHERE project_id = ? AND path = ? AND version = ?"
    )
      .bind(bytes, now, id, path, meta.version)
      .run();
    if (r.meta.changes !== 1)
      return { ok: false, conflict: true, error: `Version conflict on ${path}: another write happened at the same time. Re-read it with file_read and merge.` };
    newVersion = meta.version + 1;
  } else {
    if (state.file_count >= lim.maxFiles) return { ok: false, error: `File limit reached (${lim.maxFiles} files per project). Delete files first.` };
    if (state.total_bytes + bytes > lim.maxBytes)
      return { ok: false, error: `Project size limit reached (${formatBytes(lim.maxBytes)}). Delete or shrink files first.` };
    const r = await env.DB.prepare(
      "INSERT INTO files (project_id, path, version, size, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT DO NOTHING"
    )
      .bind(id, path, bytes, now)
      .run();
    if (r.meta.changes !== 1)
      return { ok: false, conflict: true, error: `${path} was just created by another write. Re-read it with file_read.` };
    newVersion = 1;
    dfc = 1;
  }

  try {
    await env.FILES.put(filesPrefix(id) + path, content, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { v: String(newVersion) },
    });
  } catch (e: any) {
    // best-effort rollback of the version claim
    if (meta)
      await env.DB.prepare("UPDATE files SET version = ?, size = ? WHERE project_id = ? AND path = ? AND version = ?")
        .bind(meta.version, meta.size, id, path, newVersion)
        .run();
    else await env.DB.prepare("DELETE FROM files WHERE project_id = ? AND path = ?").bind(id, path).run();
    return { ok: false, error: `Storage error while saving ${path}. Try again.` };
  }

  const delta = bytes - (meta?.size ?? 0);
  await env.DB.prepare("UPDATE projects SET total_bytes = total_bytes + ?, file_count = file_count + ?, last_activity = ? WHERE id = ?")
    .bind(delta, dfc, now, id)
    .run();
  state.total_bytes += delta;
  state.file_count += dfc;
  return { ok: true, version: newVersion, size: bytes };
}

/** Lists files from D1 (with versions). Rebuilds the index from R2 for Phase-1 projects that have none. */
export async function listFiles(env: Env, p: ProjectRow, prefix: string) {
  const query = () =>
    env.DB.prepare("SELECT path, size, version FROM files WHERE project_id = ? AND substr(path, 1, ?) = ? ORDER BY path LIMIT ?")
      .bind(p.id, prefix.length, prefix, LIST_LIMIT + 1)
      .all<{ path: string; size: number; version: number }>();
  let res = await query();
  if (res.results.length === 0 && prefix === "" && p.file_count > 0) {
    const listing = await env.FILES.list({ prefix: filesPrefix(p.id), limit: 1000 });
    const pl = filesPrefix(p.id).length;
    for (const o of listing.objects)
      await env.DB.prepare("INSERT OR IGNORE INTO files (project_id, path, version, size, updated_at) VALUES (?, ?, 1, ?, ?)")
        .bind(p.id, o.key.slice(pl), o.size, Date.now())
        .run();
    res = await query();
  }
  const rows = res.results;
  const truncated = rows.length > LIST_LIMIT;
  return { rows: truncated ? rows.slice(0, LIST_LIMIT) : rows, truncated };
}

// ---------- tools ----------

async function fileWrite(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const err = validatePath(a?.path);
  if (err) return fail(err);
  if (typeof a?.content !== "string") return fail("content must be a string.");
  const state: State = { total_bytes: p.total_bytes, file_count: p.file_count };
  const base = a.base_version === undefined || a.base_version === null ? undefined : toInt(a.base_version, -1);
  const r = await writeFile(env, p.id, state, a.path, a.content, base);
  if (!r.ok) return fail(r.error);
  p.total_bytes = state.total_bytes;
  p.file_count = state.file_count;
  const log = a.path === NOTES_FILE ? null : await autoLogChange(env, p, [`Saved ${a.path} (v${r.version}).`]);
  return ok(`Saved ${a.path} (v${r.version}, ${formatBytes(r.size)}).${log ? ` ${log}` : ""}`);
}

async function filesWrite(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const files = a?.files;
  if (!Array.isArray(files) || files.length === 0) return fail("files must be a non-empty array of {path, content, base_version?}.");
  if (files.length > MAX_BATCH_FILES) return fail(`Too many files in one call (max ${MAX_BATCH_FILES}).`);
  const seen = new Set<string>();
  for (const f of files) {
    const err = validatePath(f?.path);
    if (err) return fail(`${f?.path ?? "(no path)"}: ${err}`);
    if (typeof f.content !== "string") return fail(`${f.path}: content must be a string.`);
    if (seen.has(f.path)) return fail(`Duplicate path in one call: ${f.path}`);
    seen.add(f.path);
  }
  const state: State = { total_bytes: p.total_bytes, file_count: p.file_count };
  const lines: string[] = [];
  const changes: string[] = [];
  let failed = 0;
  for (const f of files) {
    const base = f.base_version === undefined || f.base_version === null ? undefined : toInt(f.base_version, -1);
    const r = await writeFile(env, p.id, state, f.path, f.content, base);
    if (r.ok) {
      lines.push(`OK   ${f.path} v${r.version} (${formatBytes(r.size)})`);
      if (f.path !== NOTES_FILE) changes.push(`Saved ${f.path} (v${r.version}).`);
    }
    else {
      failed++;
      lines.push(`FAIL ${f.path}: ${r.error}`);
    }
  }
  p.total_bytes = state.total_bytes;
  p.file_count = state.file_count;
  const log = changes.length ? await autoLogChange(env, p, changes) : null;
  const text = `${files.length - failed}/${files.length} saved.\n${lines.join("\n")}`;
  const withLog = log ? `${text}\n${log}` : text;
  return failed ? fail(withLog) : ok(withLog);
}

async function fileRead(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const err = validatePath(a?.path);
  if (err) return fail(err);
  const r = await readConsistent(env, p.id, a.path);
  if (!r.ok) return fail(r.error);
  const all = r.text.split("\n");
  if (all.length && all[all.length - 1] === "") all.pop();
  const total = all.length;
  if (total === 0) return ok(`${a.path} v${r.meta.version} | (empty file)`);
  const start = Math.max(1, toInt(a.start_line, 1));
  if (start > total) return fail(`start_line ${start} is beyond the end (${a.path} has ${total} lines).`);
  const wanted = toInt(a.end_line, start + MAX_READ_LINES - 1);
  const end = Math.min(total, wanted, start + MAX_READ_LINES - 1);
  const out: string[] = [];
  let chars = 0;
  let last = start - 1;
  for (let n = start; n <= end; n++) {
    const line = `${n}| ${all[n - 1]}`;
    if (chars + line.length > MAX_READ_CHARS && out.length > 0) break;
    out.push(line);
    chars += line.length + 1;
    last = n;
  }
  const more = last < total ? `\n[more: call file_read with start_line=${last + 1}]` : "";
  return ok(`${a.path} v${r.meta.version} | lines ${start}-${last} of ${total}\n${out.join("\n")}${more}`);
}

async function fileEdit(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const err = validatePath(a?.path);
  if (err) return fail(err);
  if (typeof a?.old_str !== "string" || a.old_str === "") return fail("old_str must be a non-empty string.");
  if (typeof a?.new_str !== "string") return fail("new_str must be a string (use \"\" to delete the text).");
  const strict = a.base_version !== undefined && a.base_version !== null;
  const base = strict ? toInt(a.base_version, -1) : undefined;
  const state: State = { total_bytes: p.total_bytes, file_count: p.file_count };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const r = await readConsistent(env, p.id, a.path);
    if (!r.ok) return fail(r.error);
    if (strict && base !== r.meta.version)
      return fail(`Version conflict on ${a.path}: current version is ${r.meta.version}, you sent ${base}. Re-read it with file_read.`);
    const first = r.text.indexOf(a.old_str);
    if (first < 0) return fail("old_str not found. Use file_read and copy the exact text (including spaces and line breaks).");
    if (r.text.indexOf(a.old_str, first + 1) >= 0) return fail("old_str appears more than once. Add surrounding text to make it unique.");
    const next = r.text.slice(0, first) + a.new_str + r.text.slice(first + a.old_str.length);
    state.total_bytes = p.total_bytes; // approximate; exact size limits are enforced in writeFile
    const w = await writeFile(env, p.id, state, a.path, next, r.meta.version);
    if (w.ok) {
      p.total_bytes = state.total_bytes;
      p.file_count = state.file_count;
      const log = a.path === NOTES_FILE ? null : await autoLogChange(env, p, [`Edited ${a.path} (v${w.version}).`]);
      return ok(`Edited ${a.path} (v${w.version}).${log ? ` ${log}` : ""}`);
    }
    if (w.conflict && !strict) {
      await sleep(20 * (attempt + 1));
      continue;
    }
    return fail(w.error);
  }
  return fail(`Could not edit ${a.path}: too many simultaneous writes. Try again.`);
}

async function fileList(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const prefix = typeof a?.prefix === "string" ? a.prefix : "";
  const { rows, truncated } = await listFiles(env, p, prefix);
  if (rows.length === 0) return ok(prefix ? `No files under "${prefix}".` : "No files.");
  const lines = rows.map((r) => `- ${r.path} (v${r.version}, ${formatBytes(r.size)})`);
  return ok(`${lines.join("\n")}${truncated ? `\n... more than ${LIST_LIMIT} files, narrow with prefix` : ""}`);
}

async function fileDelete(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const err = validatePath(a?.path);
  if (err) return fail(err);
  if (a.path === NOTES_FILE) return fail("NOTES.md cannot be deleted. Use notes_update or file_edit to change it.");
  const meta = await getMeta(env, p.id, a.path);
  if (!meta) return fail(`File not found: ${a.path}.`);
  await env.DB.prepare("DELETE FROM files WHERE project_id = ? AND path = ?").bind(p.id, a.path).run();
  await env.FILES.delete(filesPrefix(p.id) + a.path);
  await env.DB.prepare(
    "UPDATE projects SET total_bytes = MAX(0, total_bytes - ?), file_count = MAX(0, file_count - 1), last_activity = ? WHERE id = ?"
  )
    .bind(meta.size, Date.now(), p.id)
    .run();
  p.total_bytes = Math.max(0, p.total_bytes - meta.size);
  p.file_count = Math.max(0, p.file_count - 1);
  const log = await autoLogChange(env, p, [`Deleted ${a.path}.`]);
  return ok(`Deleted ${a.path}.${log ? ` ${log}` : ""}`);
}

// ---------- NOTES.md handling ----------

const SECTIONS: Record<string, string> = {
  goal: "Goal",
  done: "Done",
  pending: "Pending / Next steps",
  decisions: "Decisions & constraints",
  log: "Handoff log",
};
const PLACEHOLDERS = new Set(["- (nothing yet)", "- (fill in)", "(what this project is for - fill in)"]);

type Section = { title: string; body: string[] };

function parseNotes(text: string): { pre: string[]; sections: Section[] } {
  const pre: string[] = [];
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("## ")) {
      cur = { title: line.slice(3).trim(), body: [] };
      sections.push(cur);
    } else if (cur) cur.body.push(line);
    else pre.push(line);
  }
  return { pre, sections };
}

function renderNotes(n: { pre: string[]; sections: Section[] }): string {
  const parts: string[] = [];
  while (n.pre.length && n.pre[n.pre.length - 1].trim() === "") n.pre.pop();
  parts.push(n.pre.join("\n"));
  for (const s of n.sections) {
    const body = s.body.filter((l, i, arr) => !(l.trim() === "" && (i === arr.length - 1 || i === 0)));
    parts.push(`## ${s.title}\n${body.join("\n")}`.trimEnd());
  }
  return parts.join("\n\n") + "\n";
}

function toLines(key: string, text: string, stamp: boolean): string[] {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  if (key === "goal") return lines;
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  return lines.map((l) => (/^\s*([-*]|\d+\.)\s/.test(l) ? l : stamp ? `- ${ts}: ${l}` : `- ${l}`));
}

async function notesUpdate(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const key = String(a?.section ?? "").toLowerCase();
  if (!SECTIONS[key]) return fail("section must be one of: goal, done, pending, decisions, log.");
  if (typeof a?.text !== "string" || a.text.trim() === "") return fail("text is required.");
  const mode = a?.mode === "replace" ? "replace" : "append";
  const title = SECTIONS[key];
  const state: State = { total_bytes: p.total_bytes, file_count: p.file_count };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const r = await readConsistent(env, p.id, NOTES_FILE);
    if (!r.ok) return fail(r.error);
    const notes = parseNotes(r.text);
    let sec = notes.sections.find((s) => s.title.toLowerCase() === title.toLowerCase());
    if (!sec) {
      sec = { title, body: [] };
      notes.sections.push(sec);
    }
    const existing = sec.body.filter((l) => l.trim() !== "" && !PLACEHOLDERS.has(l.trim()));
    const added = toLines(key, a.text, key === "log" && mode === "append");
    sec.body = mode === "replace" ? added : [...existing, ...added];
    const next = renderNotes(notes);
    state.total_bytes = p.total_bytes;
    const w = await writeFile(env, p.id, state, NOTES_FILE, next, r.meta.version);
    if (w.ok) {
      p.total_bytes = state.total_bytes;
      p.file_count = state.file_count;
      const warn = next.length > 6000 ? ` Warning: NOTES.md is ${next.length} chars and project_open shows only the first 8000. Condense old items with mode=replace.` : "";
      return ok(`NOTES.md updated: ${title} (${mode}, v${w.version}).${warn}`);
    }
    if (w.conflict) {
      await sleep(20 * (attempt + 1));
      continue;
    }
    return fail(w.error);
  }
  return fail("Could not update NOTES.md: too many simultaneous writes. Try again.");
}

async function autoLogChange(env: Env, p: ProjectRow, changes: string[]): Promise<string | null> {
  const result = await notesUpdate(env, p, { section: "log", text: changes.join("\n"), mode: "append" });
  return result.isError ? `File is saved, but automatic NOTES.md logging failed: ${result.content[0]?.text ?? "retry notes_update"}` : "NOTES.md updated automatically.";
}

// ---------- registry ----------

const codeProp = { type: "string", description: "Project code" };

export const FILE_TOOL_DEFS = [
  {
    name: "file_write",
    description:
      "Immediately save ONE changed text file to the project after editing it; do not wait for a milestone. New file: no base_version. Existing file: base_version must equal its current version. Max 1 MB. Every successful save also appends a change entry to NOTES.md automatically. For small changes prefer file_edit.",
    inputSchema: {
      type: "object",
      properties: {
        code: codeProp,
        path: { type: "string", description: "Relative path, e.g. src/app.js" },
        content: { type: "string" },
        base_version: { type: "integer", description: "Required only when overwriting an existing file" },
      },
      required: ["code", "path", "content"],
    },
  },
  {
    name: "files_write",
    description: "Immediately save several completed files in one call (max 20). Every successful file is saved and logged in NOTES.md automatically. Check per-file OK/FAIL results before continuing.",
    inputSchema: {
      type: "object",
      properties: {
        code: codeProp,
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" }, base_version: { type: "integer" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["code", "files"],
    },
  },
  {
    name: "file_read",
    description:
      "Read a text file with line numbers and its version. Returns at most 400 lines or 30k chars per call; the result tells you the start_line to continue from.",
    inputSchema: {
      type: "object",
      properties: {
        code: codeProp,
        path: { type: "string" },
        start_line: { type: "integer", description: "1-based, default 1" },
        end_line: { type: "integer", description: "Inclusive, default start+399" },
      },
      required: ["code", "path"],
    },
  },
  {
    name: "file_edit",
    description:
      "Immediately save ONE unique text edit in the project. old_str must appear exactly once. The successful edit is also logged to NOTES.md automatically. Use new_str \"\" to delete text.",
    inputSchema: {
      type: "object",
      properties: {
        code: codeProp,
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        base_version: { type: "integer", description: "Optional strict version check" },
      },
      required: ["code", "path", "old_str", "new_str"],
    },
  },
  {
    name: "file_list",
    description: "List files with sizes and versions. Optional prefix filter such as src/.",
    inputSchema: { type: "object", properties: { code: codeProp, prefix: { type: "string" } }, required: ["code"] },
  },
  {
    name: "file_delete",
    description: "Delete one file from the project; the deletion is also logged to NOTES.md automatically. NOTES.md cannot be deleted.",
    inputSchema: { type: "object", properties: { code: codeProp, path: { type: "string" } }, required: ["code", "path"] },
  },
  {
    name: "notes_update",
    description:
      "Update NOTES.md, the handoff file the next chat reads first. File tools already log each successful file change automatically; use notes_update after EVERY milestone to summarize done, pending, and decisions. section: goal | done | pending | decisions | log. mode: append (default) or replace.",
    inputSchema: {
      type: "object",
      properties: {
        code: codeProp,
        section: { type: "string", enum: ["goal", "done", "pending", "decisions", "log"] },
        text: { type: "string" },
        mode: { type: "string", enum: ["append", "replace"] },
      },
      required: ["code", "section", "text"],
    },
  },
];

const HANDLERS: Record<string, (env: Env, p: ProjectRow, a: any) => Promise<ToolResult>> = {
  file_write: fileWrite,
  files_write: filesWrite,
  file_read: fileRead,
  file_edit: fileEdit,
  file_list: fileList,
  file_delete: fileDelete,
  notes_update: notesUpdate,
};

export async function callFileTool(env: Env, name: string, args: any): Promise<ToolResult | null> {
  const h = HANDLERS[name];
  if (!h) return null;
  const found = await findProject(env, args?.code);
  if (!found.ok) return fail(found.error);
  return h(env, found.row, args ?? {});
}
