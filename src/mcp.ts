import type { Env } from "./index";
import { TOOL_DEFS, callTool } from "./tools";
import type { Ctx } from "./downloads";

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SAVEPOINT_ICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#173B55"/><path d="M18 26h28v21H18z" fill="#F4F7F8"/><path d="M22 26v-5a10 10 0 0 1 20 0v5" fill="none" stroke="#F4F7F8" stroke-width="5" stroke-linecap="round"/><path d="m26 36 4 4 9-10" fill="none" stroke="#32B894" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
);

export const SERVER_INSTRUCTIONS = `Online project storage so work can continue across Claude accounts and chats.
- New chat with a task and no project code: call project_create FIRST (short name from the task). Your very first user-facing reply MUST include the continue box from the tool result in a code block, copied exactly, plus this one line: "Save this box. Paste it in any chat to continue this project." Do this before analysis, questions, plans, or project work. Do not omit the box or wait for the user to ask. Do not mention usage limits or future sessions.
- Existing work (user gives a code or pastes a continue box): call project_open FIRST and read NOTES.md before doing anything.
- Save every changed file to Savepoint immediately after editing it; never accumulate unsaved file changes until a milestone or until the user asks. Use file_write or file_edit for one file, and files_write when several completed files should be saved together. Confirm each save succeeded before continuing to another change. Overwriting an existing file needs base_version (its current version).
- Every successful file_write, files_write, file_edit, and file_delete also appends a change entry to NOTES.md automatically. Keep using notes_update for project goal, decisions, pending work, and milestone summaries.
- Read big files in ranges with file_read (start_line / end_line).
- After EVERY milestone call notes_update (done / pending / decisions). The chat may be cut off at any moment, so never wait until the end.
- If the user wants the files, call project_download and give them the link.
- Keep tool outputs and replies short. Files expire after 24 hours with no changes.`;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const result = (id: Rpc["id"], r: unknown) => ({ jsonrpc: "2.0", id, result: r });
const error = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleOne(env: Env, msg: Rpc, ctx: Ctx): Promise<unknown | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED.includes(asked) ? asked : SUPPORTED[0];
      return result(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "savepoint-mcp",
          version: "0.3.0",
          ...(protocolVersion === "2025-11-25"
            ? { title: "Savepoint", icons: [{ src: SAVEPOINT_ICON, mimeType: "image/svg+xml", sizes: ["any"] }] }
            : {}),
        },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return result(msg.id, {});
    case "tools/list":
      return result(msg.id, { tools: TOOL_DEFS });
    case "tools/call":
      return result(msg.id, await callTool(env, msg.params?.name, msg.params?.arguments ?? {}, ctx));
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, etc.
      return error(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(env: Env, body: unknown, ctx: Ctx): Promise<Response> {
  const headers = { "content-type": "application/json" };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleOne(env, m as Rpc, ctx)))).filter((x) => x !== null);
    return out.length ? new Response(JSON.stringify(out), { headers }) : new Response(null, { status: 202 });
  }
  if (!body || typeof body !== "object" || (body as Rpc).jsonrpc !== "2.0")
    return new Response(JSON.stringify(error(null, -32600, "Invalid Request")), { status: 400, headers });
  const out = await handleOne(env, body as Rpc, ctx);
  return out === null ? new Response(null, { status: 202 }) : new Response(JSON.stringify(out), { headers });
}
