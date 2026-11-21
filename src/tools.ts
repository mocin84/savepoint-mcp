import type { Env } from "./index";
import { cleanName, formatBytes, formatDuration, generateCode, normalizeCode, sha256Hex } from "./util";
import { initialNotes } from "./notes";
import { NOTES_FILE, continueBox, fail, filesPrefix, findProject, ok, type ToolResult } from "./project";
import { projectDownload, type Ctx } from "./downloads";
import { FILE_TOOL_DEFS, callFileTool, listFiles } from "./files";

export type { ToolResult };

const NOTES_PREVIEW_CHARS = 8000;

const BASE_TOOL_DEFS = [
  {
    name: "project_create",
    description:
      "Start a NEW online project. Returns a private project code and a short continue box. Call this first when no project code exists. The very first user-facing reply MUST show the returned continue box in a code block, copied exactly, plus the one-line save reminder. Do this before any analysis, questions, or project work; never wait for the user to ask.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Short project name" } },
      required: ["name"],
    },
  },
  {
    name: "project_open",
    description:
      "Open an EXISTING project by code. Call this FIRST when the user gives a project code. Returns the file list, time left before expiry, and NOTES.md. Read NOTES.md before continuing the work.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "Project code, e.g. ABCDE-FGHJK-MNPQR-STUVW" } },
      required: ["code"],
    },
  },
];

const DOWNLOAD_TOOL_DEF = {
  name: "project_download",
  description:
    "Make a zip of all project files and return a download link (valid ~15 min). Give the link to the user. The project stays online and its 24h timer is not reset.",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", description: "Project code" } },
    required: ["code"],
  },
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
  const notes = initialNotes(name, new Date(now).toISOString());
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
    `Project created: "${name}"\nPROJECT CODE: ${code}\n\n` +
      `FIRST REPLY REQUIREMENT: Before any analysis, questions, or work, your first reply MUST show the box below inside a code block, copied exactly, plus this one short line: "Save this box. Paste it in any chat to continue this project." Do not wait for the user to ask. Do not mention usage limits or future sessions.\n\n` +
      `${continueBox(name, code)}\n\n` +
      `Save every changed file immediately after editing it. Successful file tools also append changes to ${NOTES_FILE}; use notes_update for milestone summaries and pending work. Files expire after 24 hours with no changes.`
  );
}

async function projectOpen(env: Env, args: any): Promise<ToolResult> {
  const found = await findProject(env, args?.code);
  if (!found.ok) return fail(found.error);
  const { row, expiryMs } = found;

  const { rows, truncated } = await listFiles(env, row, "");
  const tree = rows.map((r) => `- ${r.path} (v${r.version}, ${formatBytes(r.size)})`).join("\n") || "(no files)";
  const more = truncated ? "\n... more files, use file_list with a prefix" : "";

  const notesObj = await env.FILES.get(filesPrefix(row.id) + NOTES_FILE);
  let notes = notesObj ? await notesObj.text() : "(NOTES.md missing)";
  if (notes.length > NOTES_PREVIEW_CHARS) notes = notes.slice(0, NOTES_PREVIEW_CHARS) + "\n... [NOTES.md truncated, use file_read for the rest]";

  const left = formatDuration(row.last_activity + expiryMs - Date.now());
  return ok(
    `Project: ${row.name}\nExpires in: ${left} (timer resets when files change; opening does not reset it)\n` +
      `Files: ${row.file_count}, ${formatBytes(row.total_bytes)}\n\n## File tree\n${tree}${more}\n\n## ${NOTES_FILE}\n${notes}`
  );
}

export async function callTool(env: Env, name: string, args: any, ctx: Ctx): Promise<ToolResult> {
  try {
    if (name === "project_create") return await projectCreate(env, args);
    if (name === "project_open") return await projectOpen(env, args);
    if (name === "project_download") return await projectDownload(env, args, ctx);
    const r = await callFileTool(env, name, args);
    if (r) return r;
    return fail(`Unknown tool: ${name}`);
  } catch (e: any) {
    return fail(`Server error: ${e?.message ?? "unknown"}`);
  }
}
