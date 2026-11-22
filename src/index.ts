import { handleMcp } from "./mcp";
import { cleanup, handleDownload } from "./downloads";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ACCESS_KEY?: string;
  PUBLIC_ORIGIN?: string;
  MAX_PROJECTS_PER_DAY?: string;
  RATE_LIMIT_PER_MIN?: string;
  EXPIRY_HOURS?: string;
  MAX_PROJECT_BYTES?: string;
  MAX_FILES?: string;
  MAX_FILE_BYTES?: string;
  DOWNLOAD_MINUTES?: string;
  CLEANUP_BUDGET?: string;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
};

function withCors(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

function authorized(req: Request, env: Env, url: URL): boolean {
  if (!env.ACCESS_KEY) return true; // open mode (rate limits still apply)
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const q = url.searchParams.get("key") ?? "";
  return bearer === env.ACCESS_KEY || q === env.ACCESS_KEY;
}

async function rateLimited(req: Request, env: Env): Promise<boolean> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_MIN ?? "120");
  const window = Math.floor(Date.now() / 60000);
  const key = `${ip}:${window}`;
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count"
  )
    .bind(key, window)
    .first<{ count: number }>();
  // opportunistic cleanup of old windows
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(window - 5).run();
  return (row?.count ?? 0) > limit;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    if (url.pathname === "/" || url.pathname === "/health")
      return withCors(new Response("savepoint-mcp is running. MCP endpoint: /mcp", { status: 200 }));

    // Download links: the token is the secret, so no ACCESS_KEY needed.
    if (url.pathname.startsWith("/dl/")) {
      if (req.method !== "GET") return withCors(new Response("Method not allowed", { status: 405 }));
      if (await rateLimited(req, env)) return withCors(new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } }));
      return withCors(await handleDownload(env, url.pathname.slice(4)));
    }

    if (url.pathname !== "/mcp") return withCors(new Response("Not found", { status: 404 }));

    if (!authorized(req, env, url)) return withCors(new Response("Unauthorized", { status: 401 }));

    if (req.method === "GET") return withCors(new Response("SSE stream not supported", { status: 405 }));
    if (req.method === "DELETE") return withCors(new Response(null, { status: 200 }));
    if (req.method !== "POST") return withCors(new Response("Method not allowed", { status: 405 }));

    if (await rateLimited(req, env))
      return withCors(new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } }));

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return withCors(new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: { "content-type": "application/json" } }));
    }
    const origin = env.PUBLIC_ORIGIN?.replace(/\/+$/, "") || url.origin;
    return withCors(await handleMcp(env, body, { origin }));
  },

  // Hourly cron: delete expired projects, old zips and old rate-limit rows.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanup(env).then((r) => console.log("cleanup", JSON.stringify(r))));
  },
};
