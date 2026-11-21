import type { Env } from "./index";
import { isValidCode, normalizeCode, sha256Hex } from "./util";

export const NOTES_FILE = "NOTES.md";
export const filesPrefix = (id: string) => `p/${id}/files/`;

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export type ProjectRow = {
  id: string;
  name: string;
  created_at: number;
  last_activity: number;
  total_bytes: number;
  file_count: number;
};
export type Found = { ok: true; row: ProjectRow; expiryMs: number } | { ok: false; error: string };

export function limits(env: Env) {
  return {
    maxBytes: Number(env.MAX_PROJECT_BYTES ?? "26214400"),
    maxFiles: Number(env.MAX_FILES ?? "200"),
    maxFileBytes: Number(env.MAX_FILE_BYTES ?? "1048576"),
  };
}

export async function findProject(env: Env, code: unknown): Promise<Found> {
  const norm = normalizeCode(String(code ?? ""));
  if (!isValidCode(norm))
    return { ok: false, error: "Invalid project code format. It should look like ABCDE-FGHJK-MNPQR-STUVW." };
  const id = await sha256Hex(norm);
  const row = await env.DB.prepare(
    "SELECT id, name, created_at, last_activity, total_bytes, file_count FROM projects WHERE id = ?"
  )
    .bind(id)
    .first<ProjectRow>();
  if (!row) return { ok: false, error: "Project not found or expired. Ask the user to double-check the code, or create a new project." };
  const expiryMs = Number(env.EXPIRY_HOURS ?? "24") * 3600_000;
  if (Date.now() - row.last_activity > expiryMs)
    return { ok: false, error: "This project has expired (no changes for 24 hours) and its files are removed. Create a new project." };
  return { ok: true, row, expiryMs };
}

/** Short copy-paste box shown to the user in Claude's first reply (code + how to continue). */
export function continueBox(name: string, code: string): string {
  const n = String(name).replace(/[`"]/g, "'");
  return (
    "```\n" +
    `Continue my project "${n}".\n` +
    `Use the Savepoint connector: call project_open with code ${code}, read NOTES.md, then continue from Pending.\n` +
    `Save files and update NOTES.md after every step.\n` +
    "```"
  );
}
