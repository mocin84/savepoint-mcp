import type { Env } from "./index";
import { NOTES_FILE, fail, filesPrefix, findProject, limits, ok, type ProjectRow, type ToolResult } from "./project";
import { formatBytes, sleep, toInt, validatePath } from "./util";
import { assetLinkText, cleanFolder, mimeFor, uploadLinkText } from "./assets";

export type FileCtx = { origin: string };

const enc = new TextEncoder();
const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 30000;
const LIST_LIMIT = 300;
const MAX_BATCH_FILES = 20;
const MAX_RETRIES = 6;
/** Inline base64 in a save call is for small things only (icons, fonts); it costs model tokens. */
const MAX_INLINE_BINARY = 256 * 1024;

type FileMeta = { version: number; size: number; ctype?: string | null };
export type State = { total_bytes: number; file_count: number };
type WriteResult = { ok: true; version: number; size: number } | { ok: false; error: string; conflict?: boolean };
type ReadResult = { ok: true; meta: FileMeta; text: string } | { ok: false; error: string };
/** Binary content: a stream with a known length (uploads) or bytes (inline base64). */
export type BinaryBody = { body: ReadableStream | Uint8Array; bytes: number; ctype: string };

// ---------- schema upgrade (once per isolate) ----------

let schemaReady: Promise<void> | null = null;
/** Adds the columns/tables media support needs to databases created before it existed. */
export function ensureMediaSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await env.DB.prepare("ALTER TABLE files ADD COLUMN ctype TEXT").run();
      } catch {
        /* column already exists */
      }
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS links (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT NOT NULL, path TEXT NOT NULL, expires_at INTEGER NOT NULL)"
      ).run();
    })().catch((e) => {
      schemaReady = null; // retry on the next request
      throw e;
    });
  }
  return schemaReady;
}

// ---------- helpers ----------

/** D1 row is the source of truth for versions. Phase-1 projects had NOTES.md without a row: adopt it as v1. */
export async function getMeta(env: Env, id: string, path: string): Promise<FileMeta | null> {
  await ensureMediaSchema(env);
  const r = await env.DB.prepare("SELECT version, size, ctype FROM files WHERE project_id = ? AND path = ?")
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
    if (!meta) return { ok: false, error: `File not found: ${path}. Use read without a path to list files.` };
    if (meta.ctype) return { ok: false, error: `${path} is a binary file (${meta.ctype}); it has no text to read or edit.` };
    const obj = await env.FILES.get(filesPrefix(id) + path);
    if (!obj) return { ok: false, error: `File not found: ${path}. Use read without a path to list files.` };
    const v = obj.customMetadata?.v;
    if ((v === undefined && meta.version === 1) || v === String(meta.version)) return { ok: true, meta, text: await obj.text() };
    await sleep(40);
  }
  return { ok: false, error: "File is being updated by another write. Retry in a moment." };
}

/** Total bytes stored by all live projects (guards the free R2 tier). */
async function globalBytes(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(total_bytes), 0) AS b FROM projects").first<{ b: number }>();
  return r?.b ?? 0;
}

export async function writeFile(
  env: Env,
  id: string,
  state: State,
  path: string,
  content: string | BinaryBody,
  baseVersion: number | undefined
): Promise<WriteResult> {
  const lim = limits(env);
  const binary = typeof content !== "string";
  const bytes = binary ? content.bytes : enc.encode(content).length;
  if (!binary) {
    if (content.includes("\u0000")) return { ok: false, error: "Binary content: use base64 (small files) or an upload link." };
    if (bytes > lim.maxFileBytes)
      return { ok: false, error: `File too large (${formatBytes(bytes)}). Max ${formatBytes(lim.maxFileBytes)} per text file. Split it into smaller files.` };
  } else {
    if (bytes > lim.maxAssetBytes) return { ok: false, error: `Asset too large (${formatBytes(bytes)}). Max ${formatBytes(lim.maxAssetBytes)} per file.` };
    if ((await globalBytes(env)) + bytes > lim.globalBytes)
      return { ok: false, error: "SavePoint storage is full right now. Save the source files instead and try the upload later." };
  }
  const ctype = binary ? content.ctype : null;

  const meta = await getMeta(env, id, path);
  const now = Date.now();
  let newVersion: number;
  let dfc = 0;

  if (meta) {
    // No base_version = overwrite the current version (one chat owns its project;
    // forcing version tracking costs a read + retry round trip for every save).
    if (baseVersion === undefined) baseVersion = meta.version;
    if (baseVersion !== meta.version)
      return { ok: false, conflict: true, error: `Version conflict on ${path}: current version is ${meta.version}, you sent ${baseVersion}. Re-read it and merge your changes.` };
    if (state.total_bytes - meta.size + bytes > lim.maxBytes)
      return { ok: false, error: `Project size limit reached (${formatBytes(lim.maxBytes)}). Delete or shrink files first.` };
    const r = await env.DB.prepare(
      "UPDATE files SET version = version + 1, size = ?, updated_at = ?, ctype = ? WHERE project_id = ? AND path = ? AND version = ?"
    )
      .bind(bytes, now, ctype, id, path, meta.version)
      .run();
    if (r.meta.changes !== 1)
      return { ok: false, conflict: true, error: `Version conflict on ${path}: another write happened at the same time. Re-read it and merge.` };
    newVersion = meta.version + 1;
  } else {
    if (state.file_count >= lim.maxFiles) return { ok: false, error: `File limit reached (${lim.maxFiles} files per project). Delete files first.` };
    if (state.total_bytes + bytes > lim.maxBytes)
      return { ok: false, error: `Project size limit reached (${formatBytes(lim.maxBytes)}). Delete or shrink files first.` };
    const r = await env.DB.prepare(
      "INSERT INTO files (project_id, path, version, size, updated_at, ctype) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING"
    )
      .bind(id, path, bytes, now, ctype)
      .run();
    if (r.meta.changes !== 1)
      return { ok: false, conflict: true, error: `${path} was just created by another write. Re-read it.` };
    newVersion = 1;
    dfc = 1;
  }

  try {
    await env.FILES.put(filesPrefix(id) + path, binary ? content.body : content, {
      httpMetadata: { contentType: ctype ?? "text/plain; charset=utf-8" },
      customMetadata: { v: String(newVersion) },
    });
  } catch (e: any) {
    // best-effort rollback of the version claim
    if (meta)
      await env.DB.prepare("UPDATE files SET version = ?, size = ?, ctype = ? WHERE project_id = ? AND path = ? AND version = ?")
        .bind(meta.version, meta.size, meta.ctype ?? null, id, path, newVersion)
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

/** Decodes small inline base64 binaries from a save call. */
function decodeInline(b64: string, ctype: unknown): BinaryBody | string {
  const clean = b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return "base64 is not valid.";
  if (clean.length > Math.ceil(MAX_INLINE_BINARY / 3) * 4)
    return `Inline base64 is limited to ${formatBytes(MAX_INLINE_BINARY)}; use upload_folder for bigger files.`;
  const raw = atob(clean);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const type = typeof ctype === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(ctype) ? ctype : "application/octet-stream";
  return { body: bytes, bytes: bytes.length, ctype: type };
}

/** Lists files from D1 (with versions). Rebuilds the index from R2 for Phase-1 projects that have none. */
export async function listFiles(env: Env, p: ProjectRow, prefix: string) {
  const query = () =>
    env.DB.prepare("SELECT path, size, version, ctype FROM files WHERE project_id = ? AND substr(path, 1, ?) = ? ORDER BY path LIMIT ?")
      .bind(p.id, prefix.length, prefix, LIST_LIMIT + 1)
      .all<{ path: string; size: number; version: number; ctype: string | null }>();
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

type Edit = { path: string; old: string; new: string };

/** Applies one unique-string edit, retrying on concurrent writes. */
async function applyEdit(env: Env, p: ProjectRow, state: State, e: Edit): Promise<WriteResult> {
  if (typeof e.old !== "string" || e.old === "") return { ok: false, error: "old must be a non-empty string." };
  if (typeof e.new !== "string") return { ok: false, error: 'new must be a string ("" deletes).' };
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const r = await readConsistent(env, p.id, e.path);
    if (!r.ok) return { ok: false, error: r.error };
    const first = r.text.indexOf(e.old);
    if (first < 0) return { ok: false, error: "old text not found; read the file and copy it exactly." };
    if (r.text.indexOf(e.old, first + 1) >= 0) return { ok: false, error: "old text appears more than once; include more context." };
    const next = r.text.slice(0, first) + e.new + r.text.slice(first + e.old.length);
    const w = await writeFile(env, p.id, state, e.path, next, r.meta.version);
    if (w.ok || !w.conflict) return w;
    await sleep(20 * (attempt + 1));
  }
  return { ok: false, error: "too many simultaneous writes; try again." };
}

/** Appends text to a file (creating it if needed): lets long files be saved section by section while they are written. */
async function appendText(env: Env, p: ProjectRow, state: State, path: string, more: string): Promise<WriteResult> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const m = await getMeta(env, p.id, path);
    if (!m) {
      const w = await writeFile(env, p.id, state, path, more, undefined);
      if (w.ok || !w.conflict) return w;
    } else {
      const r = await readConsistent(env, p.id, path);
      if (!r.ok) return { ok: false, error: r.error };
      const w = await writeFile(env, p.id, state, path, r.text + more, r.meta.version);
      if (w.ok || !w.conflict) return w;
    }
    await sleep(20 * (attempt + 1));
  }
  return { ok: false, error: "too many simultaneous writes; try again." };
}

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * save: one call stores changed files (full content and/or small edits) and,
 * optionally, the step summary in NOTES.md. Replies are deliberately terse.
 */
async function save(env: Env, p: ProjectRow, a: any, ctx: FileCtx): Promise<ToolResult> {
  const files: any[] = Array.isArray(a?.files) ? a.files : [];
  const edits: any[] = Array.isArray(a?.edits) ? a.edits : [];
  const hasNotes = [a?.done, a?.next, a?.decisions, a?.goal, a?.build].some(str);
  const wantsUpload = a?.upload_folder !== undefined && a?.upload_folder !== null;
  if (!files.length && !edits.length && !hasNotes && !wantsUpload) return fail("Nothing to save: pass files, edits, done/next, or upload_folder.");
  if (files.length + edits.length > MAX_BATCH_FILES) return fail(`Max ${MAX_BATCH_FILES} files/edits per call.`);
  const seen = new Set<string>();
  for (const f of files) {
    const err = validatePath(f?.path);
    if (err) return fail(`${f?.path ?? "(no path)"}: ${err}`);
    if (typeof f.content !== "string" && typeof f.base64 !== "string") return fail(`${f.path}: pass content (text) or base64 (small binary).`);
    if (seen.has(f.path)) return fail(`Duplicate path: ${f.path}`);
    seen.add(f.path);
  }
  for (const e of edits) {
    const err = validatePath(e?.path);
    if (err) return fail(`${e?.path ?? "(no path)"}: ${err}`);
  }

  const state: State = { total_bytes: p.total_bytes, file_count: p.file_count };
  const okParts: string[] = [];
  const failParts: string[] = [];
  const changed: string[] = [];
  for (const f of files) {
    const base = f.base_version === undefined || f.base_version === null ? undefined : toInt(f.base_version, -1);
    if (f.append === true && typeof f.content === "string") {
      const r = await appendText(env, p, state, f.path, f.content);
      if (r.ok) {
        okParts.push(`${f.path} v${r.version} (+${formatBytes(new TextEncoder().encode(f.content).length)})`);
        if (f.path !== NOTES_FILE) changed.push(f.path);
      } else failParts.push(`${f.path}: ${r.error}`);
      continue;
    }
    let body: string | BinaryBody = f.content;
    if (typeof f.content !== "string") {
      const decoded = decodeInline(f.base64, f.type ?? mimeFor(f.path));
      if (typeof decoded === "string") {
        failParts.push(`${f.path}: ${decoded}`);
        continue;
      }
      body = decoded;
    }
    const r = await writeFile(env, p.id, state, f.path, body, base);
    if (r.ok) {
      okParts.push(`${f.path} v${r.version}`);
      if (f.path !== NOTES_FILE) changed.push(f.path);
    } else failParts.push(`${f.path}: ${r.error}`);
  }
  for (const e of edits) {
    const r = await applyEdit(env, p, state, e);
    if (r.ok) {
      okParts.push(`${e.path} v${r.version}`);
      if (e.path !== NOTES_FILE) changed.push(e.path);
    } else failParts.push(`${e.path}: ${r.error}`);
  }
  p.total_bytes = state.total_bytes;
  p.file_count = state.file_count;

  const ops: NoteOp[] = [];
  if (str(a?.goal)) ops.push({ key: "goal", text: a.goal, mode: "replace" });
  if (str(a?.done)) ops.push({ key: "done", text: a.done, mode: "append" });
  if (str(a?.next)) ops.push({ key: "pending", text: a.next, mode: "replace" });
  if (str(a?.decisions)) ops.push({ key: "decisions", text: a.decisions, mode: "append" });
  if (str(a?.build)) ops.push({ key: "build", text: a.build, mode: "replace" });
  if (changed.length) ops.push({ key: "log", text: `saved ${[...new Set(changed)].join(", ")}`, mode: "append" });
  let noteMsg = "";
  if (ops.length) {
    const n = await updateNotes(env, p, ops);
    noteMsg = n.ok ? (hasNotes ? " notes ok" : "") : ` (files saved; NOTES.md failed: ${n.error})`;
  }
  let upload = "";
  if (wantsUpload) {
    const folder = cleanFolder(a.upload_folder);
    if (folder === null) failParts.push(`upload_folder: invalid folder "${a.upload_folder}"`);
    else upload = "\n" + (await uploadLinkText(env, p, folder, ctx.origin));
  }
  const saved = okParts.length ? "saved " + okParts.join(", ") : "";
  const failed = failParts.length ? `\nFAILED ${failParts.join("\nFAILED ")}` : "";
  const text = `${saved}${failed}${noteMsg}${upload}`.trim() || "ok";
  return failParts.length ? fail(text) : ok(text);
}

async function read(env: Env, p: ProjectRow, a: any, ctx: FileCtx): Promise<ToolResult> {
  if (a?.path === undefined || a?.path === null || a?.path === "") return list(env, p, a);
  const err = validatePath(a.path);
  if (err) return fail(err);
  const m = await getMeta(env, p.id, a.path);
  if (m?.ctype) return ok(await assetLinkText(env, p, a.path, m.ctype, m.size, m.version, ctx.origin));
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
  const more = last < total ? `\n[more: call read with start_line=${last + 1}]` : "";
  return ok(`${a.path} v${r.meta.version} | lines ${start}-${last} of ${total}\n${out.join("\n")}${more}`);
}

async function list(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const prefix = typeof a?.prefix === "string" ? a.prefix : "";
  const { rows, truncated } = await listFiles(env, p, prefix);
  if (rows.length === 0) return ok(prefix ? `No files under "${prefix}".` : "No files.");
  const lines = rows.map((r) => `- ${r.path} (v${r.version}, ${r.ctype ? `${r.ctype}, ` : ""}${formatBytes(r.size)})`);
  return ok(`${lines.join("\n")}${truncated ? `\n... more than ${LIST_LIMIT} files, narrow with prefix` : ""}`);
}

async function remove(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const err = validatePath(a?.path);
  if (err) return fail(err);
  if (a.path === NOTES_FILE) return fail("NOTES.md cannot be deleted.");
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
  const n = await updateNotes(env, p, [{ key: "log", text: `deleted ${a.path}`, mode: "append" }]);
  return ok(`Deleted ${a.path}.${n.ok ? "" : ` (NOTES.md failed: ${n.error})`}`);
}

// ---------- NOTES.md handling ----------

const SECTIONS: Record<string, string> = {
  goal: "Goal",
  done: "Done",
  pending: "Pending / Next steps",
  decisions: "Decisions & constraints",
  log: "Handoff log",
  build: "How to build",
};
const PLACEHOLDERS = new Set([
  "- (nothing yet)",
  "- (fill in)",
  "(what this project is for - fill in)",
  "- Start the task in Goal (nothing saved yet)",
]);
/** The automatic log keeps only recent lines so NOTES.md (read on every resume) stays small. */
const LOG_KEEP = 15;

type Section = { title: string; body: string[] };
type NoteOp = { key: string; text: string; mode: "append" | "replace" };

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

/** Applies several section updates to NOTES.md in one read-modify-write. */
export async function updateNotes(
  env: Env,
  p: ProjectRow,
  ops: NoteOp[]
): Promise<{ ok: true; version: number; size: number } | { ok: false; error: string }> {
  const state: State = { total_bytes: p.total_bytes, file_count: p.file_count };
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const r = await readConsistent(env, p.id, NOTES_FILE);
    if (!r.ok) return { ok: false, error: r.error };
    const notes = parseNotes(r.text);
    for (const op of ops) {
      const title = SECTIONS[op.key];
      let sec = notes.sections.find((s) => s.title.toLowerCase() === title.toLowerCase());
      if (!sec) {
        sec = { title, body: [] };
        notes.sections.push(sec);
      }
      const existing = sec.body.filter((l) => l.trim() !== "" && !PLACEHOLDERS.has(l.trim()));
      const added = toLines(op.key, op.text, op.key === "log" && op.mode === "append");
      let body = op.mode === "replace" ? added : [...existing, ...added];
      if (op.key === "log" && body.length > LOG_KEEP) body = body.slice(-LOG_KEEP);
      sec.body = body;
    }
    const next = renderNotes(notes);
    state.total_bytes = p.total_bytes;
    const w = await writeFile(env, p.id, state, NOTES_FILE, next, r.meta.version);
    if (w.ok) {
      p.total_bytes = state.total_bytes;
      p.file_count = state.file_count;
      return { ok: true, version: w.version, size: next.length };
    }
    if (w.conflict) {
      await sleep(20 * (attempt + 1));
      continue;
    }
    return { ok: false, error: w.error };
  }
  return { ok: false, error: "too many simultaneous writes" };
}

/** Legacy notes_update (kept as a hidden alias). */
async function notesUpdate(env: Env, p: ProjectRow, a: any): Promise<ToolResult> {
  const key = String(a?.section ?? "").toLowerCase();
  if (!SECTIONS[key]) return fail("section must be one of: goal, done, pending, decisions, log.");
  if (typeof a?.text !== "string" || a.text.trim() === "") return fail("text is required.");
  const mode = a?.mode === "replace" ? "replace" : "append";
  const n = await updateNotes(env, p, [{ key, text: a.text, mode }]);
  if (!n.ok) return fail(`Could not update NOTES.md: ${n.error}`);
  const warn = n.size > 6000 ? " Warning: NOTES.md is long; condense with mode=replace." : "";
  return ok(`NOTES.md updated: ${SECTIONS[key]} (${mode}, v${n.version}).${warn}`);
}

// ---------- registry ----------

const codeProp = { type: "string", description: "Project code" };

/** Kept short on purpose: tool definitions are loaded into every chat that has the connector on. */
export const FILE_TOOL_DEFS = [
  {
    name: "save",
    title: "Save to SavePoint",
    description:
      "Save work right after each change. files: full text content (or small base64 binary). edits: small replacements (old must match once). done/next/build update NOTES.md in the same call. upload_folder returns an upload link for videos, images, PDFs and other big binaries.",
    annotations: { title: "Save to SavePoint", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        code: codeProp,
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              append: { type: "boolean", description: "Add content to the end; save long files section by section" },
              base64: { type: "string", description: "Binary up to 256 KB instead of content" },
              type: { type: "string", description: "MIME type for base64" },
            },
            required: ["path"],
          },
        },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
            required: ["path", "old", "new"],
          },
        },
        done: { type: "string", description: "What this step finished" },
        next: { type: "string", description: "Remaining work (replaces Next)" },
        build: { type: "string", description: "How to rebuild outputs (render/export commands, tools); replaces How to build" },
        decisions: { type: "string" },
        goal: { type: "string" },
        upload_folder: { type: "string", description: "Get an upload link for binaries into this folder, e.g. renders/" },
      },
      required: ["code"],
    },
  },
  {
    name: "read",
    title: "Read from SavePoint",
    description: "Read a text file with line numbers (max 400 lines per call); a binary file returns a download link. Omit path to list files.",
    annotations: { title: "Read from SavePoint", readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        code: codeProp,
        path: { type: "string" },
        start_line: { type: "integer" },
        end_line: { type: "integer" },
        prefix: { type: "string", description: "List filter when path is omitted" },
      },
      required: ["code"],
    },
  },
  {
    name: "remove",
    title: "Delete a SavePoint file",
    description: "Delete one file (not NOTES.md).",
    annotations: { title: "Delete a SavePoint file", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { code: codeProp, path: { type: "string" } }, required: ["code", "path"] },
  },
];

type Handler = (env: Env, p: ProjectRow, a: any, ctx: FileCtx) => Promise<ToolResult>;

/** Older tool names still work so existing chats and continue boxes don't break. */
const legacy: Record<string, Handler> = {
  file_write: (env, p, a, ctx) => save(env, p, { files: [{ path: a?.path, content: a?.content, base_version: a?.base_version }] }, ctx),
  files_write: (env, p, a, ctx) => save(env, p, { files: a?.files }, ctx),
  file_edit: (env, p, a, ctx) => save(env, p, { edits: [{ path: a?.path, old: a?.old_str, new: a?.new_str }] }, ctx),
  file_read: read,
  file_list: list,
  file_delete: remove,
  notes_update: notesUpdate,
};

const HANDLERS: Record<string, Handler> = { save, read, remove, ...legacy };

export async function callFileTool(env: Env, name: string, args: any, ctx: FileCtx): Promise<ToolResult | null> {
  const h = HANDLERS[name];
  if (!h) return null;
  const found = await findProject(env, args?.code);
  if (!found.ok) return fail(found.error);
  return h(env, found.row, args ?? {}, ctx);
}
