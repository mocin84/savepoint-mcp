import type { Env } from "./index";
import { cleanName, formatBytes, formatDuration, generateCode, normalizeCode, sha256Hex } from "./util";
import { initialNotes } from "./notes";
import { NOTES_FILE, continueBox, fail, filesPrefix, findProject, ok, type ToolResult } from "./project";
import { projectDownload, type Ctx } from "./downloads";
import { FILE_TOOL_DEFS, callFileTool, listFiles } from "./files";

export type { ToolResult };

const NOTES_PREVIEW_CHARS = 6000;

// Short on purpose: these definitions load into every chat that has the connector on.
const BASE_TOOL_DEFS = [
  {
    name: "project_start",
    title: "Start a SavePoint project",
    description: "Call first, before any work. Returns the code box; show it before doing anything else.",
    annotations: { title: "Start a SavePoint project", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short project name" },
        task: { type: "string", description: "The user's request in 1-3 lines, so a new chat can start the work even if nothing was saved yet" },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "project_open",
    title: "Open a SavePoint project",
    description: "Open a project by code. Returns files and NOTES.md; continue from Next.",
    annotations: { title: "Open a SavePoint project", readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { code: { type: "string", description: "Project code" } }, required: ["code"] },
  },
];

const DOWNLOAD_TOOL_DEF = {
  name: "project_download",
  title: "Download SavePoint project",
  description: "Zip all files and return a download link (valid ~15 min). Only when the user asks.",
  annotations: { title: "Download SavePoint project", readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: "object", properties: { code: { type: "string", description: "Project code" } }, required: ["code"] },
};

export const TOOL_DEFS = [...BASE_TOOL_DEFS, ...FILE_TOOL_DEFS, DOWNLOAD_TOOL_DEF];

async function projectCreate(env: Env, args: any): Promise<ToolResult> {
  const now = Date.now();
  const cap = Number(env.MAX_PROJECTS_PER_DAY ?? "200");
  const recent = await env.DB.prepare("SELECT COUNT(*) AS c FROM projects WHERE created_at > ?")
    .bind(now - 86400_000)
    .first<{ c: number }>();
  if ((recent?.c ?? 0) >= cap) return fail("Daily project creation limit reached on this server. Try again tomorrow.");

  const name = cleanName(args?.name);
  const code = generateCode();
  const id = await sha256Hex(normalizeCode(code));
  const task = typeof args?.task === "string" ? args.task.trim().slice(0, 2000) : "";
  const notes = initialNotes(name, new Date(now).toISOString(), task);
  const bytes = new TextEncoder().encode(notes).length;

  await env.FILES.put(filesPrefix(id) + NOTES_FILE, notes, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { v: "1" },
  });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (id, name, created_at, last_activity, total_bytes, file_count) VALUES (?, ?, ?, ?, ?, 1)").bind(id, name, now, now, bytes),
    env.DB.prepare("INSERT INTO files (project_id, path, version, size, updated_at) VALUES (?, ?, 1, ?, ?)").bind(id, NOTES_FILE, bytes, now),
  ]);

  return ok(
    `${continueBox(name, code)}\nNow write this box as the first thing in your reply, before any other tool call or work. Then start the task and save each file right after you change it.`
  );
}

async function projectOpen(env: Env, args: any): Promise<ToolResult> {
  const found = await findProject(env, args?.code);
  if (!found.ok) return fail(found.error);
  const { row, expiryMs } = found;

  const { rows, truncated } = await listFiles(env, row, "");
  // Paths only: versions and sizes are not needed to continue and cost tokens on every resume.
  const tree = rows.map((r) => (r.ctype ? `- ${r.path} [${r.ctype}, ${formatBytes(r.size)}]` : `- ${r.path}`)).join("\n") || "(no files)";
  const more = truncated ? "\n... more files, use read with a prefix" : "";

  const notesObj = await env.FILES.get(filesPrefix(row.id) + NOTES_FILE);
  let notes = notesObj ? await notesObj.text() : "(NOTES.md missing)";
  if (notes.length > NOTES_PREVIEW_CHARS) notes = notes.slice(0, NOTES_PREVIEW_CHARS) + "\n... [NOTES.md truncated; use read for the rest]";

  const left = formatDuration(row.last_activity + expiryMs - Date.now());
  return ok(
    `Project: ${row.name} | code ${normalizeCode(String(args?.code)).match(/.{1,5}/g)?.join("-")}\nExpires in: ${left} (resets on save)\n` +
      `Files: ${row.file_count}, ${formatBytes(row.total_bytes)}\n${tree}${more}\n\n## ${NOTES_FILE}\n${notes}`
  );
}

export async function callTool(env: Env, name: string, args: any, ctx: Ctx): Promise<ToolResult> {
  try {
    if (name === "project_start" || name === "project_create") return await projectCreate(env, args);
    if (name === "project_open") return await projectOpen(env, args);
    if (name === "project_download") return await projectDownload(env, args, ctx);
    const r = await callFileTool(env, name, args, ctx);
    if (r) return r;
    return fail(`Unknown tool: ${name}`);
  } catch (e: any) {
    return fail(`Server error: ${e?.message ?? "unknown"}`);
  }
}
