import type { Env } from "./index";
import { TOOL_DEFS, callTool } from "./tools";
import type { Ctx } from "./downloads";
import { ICON_SVG } from "./brand";

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SAVEPOINT_ICON = "data:image/svg+xml," + encodeURIComponent(ICON_SVG);

// Loaded into every chat that has the connector on, so every word costs tokens.
// It is written as default behaviour: the user should never have to ask.
export const SERVER_INSTRUCTIONS = `SavePoint keeps this chat's work online so it can continue in any chat or account. Follow this by default; the user does not need to ask.
1. Code first: when the user asks for work that creates or changes files, code, or documents and no project is open, your very first action is project_start (pass the request as task). Before any planning, reading, other tool calls, or work, write the box it returns, copied exactly. Only then start the task. The chat may hit its limit at any moment; the user must already have the code. Skip only for quick questions with no deliverable.
2. Existing material: if the chat already holds work (attached or pasted files, earlier output), do the same: project_start, show the box, then save that material before continuing.
3. Resume: if the user gives a project code or pastes a SavePoint box, call project_open first and continue from Next in NOTES.md.
4. Live sync: call save right after you create or change each file. Use edits for small changes, files for new or rewritten files. Never leave changes unsaved.
5. When a step finishes, pass done and next in that same save call. Do not make separate notes calls.
6. Wrap-up: if the user says wrap up, stop, or that they are near their limit, or this chat has grown very long, save anything unsaved with done and next right away, then repeat the box in two lines.
7. Don't narrate saves or repeat file contents in chat. Keep it brief.`;

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
          version: "0.4.0",
          ...(protocolVersion === "2025-11-25"
            ? { title: "SavePoint", icons: [{ src: SAVEPOINT_ICON, mimeType: "image/svg+xml", sizes: ["any"] }] }
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
