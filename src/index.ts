import {
  AuthorizationError,
  OAuthProvider,
  authorizationErrorRedirect,
  type OAuthHelpers,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { handleMcp } from "./mcp";
import { cleanup, handleDownload } from "./downloads";
import { publicIcon, publicPage } from "./site";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  ACCESS_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
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

const SAVEPOINT_SCOPE = "savepoint:access";
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

function originFor(req: Request, env: Env): string {
  return env.PUBLIC_ORIGIN?.replace(/\/+$/, "") || new URL(req.url).origin;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function loginPage(details: Awaited<ReturnType<OAuthHelpers["describeConsent"]>>, handle: string): string {
  const name = escapeHtml(details.clientName);
  const domain = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = details.scope.map(escapeHtml).join(", ") || SAVEPOINT_SCOPE;
  const loopback = details.redirectIsLoopback
    ? '<p class="local-warning">This will send access to an app on your computer. Continue only if you just started this sign-in.</p>'
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Savepoint</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;background:#0c1721;color:#e9f0f4}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(100%,440px);padding:32px;border:1px solid #294358;border-radius:20px;background:#122330;box-shadow:0 24px 80px #03090e88}.brand{display:flex;align-items:center;gap:12px;color:#79dec3;font-weight:700}.brand img{width:38px;height:38px}h1{font-size:25px;line-height:1.2;margin:24px 0 10px}p{color:#c1d0d9}.details{padding:14px;border-radius:12px;background:#0c1b26;margin:20px 0}.details strong{color:#f5f8fa}.actions{display:grid;gap:10px;margin-top:22px}.button{width:100%;border:0;border-radius:10px;padding:13px 16px;font:inherit;font-weight:650;cursor:pointer}.google{background:#f7f9fb;color:#202a32}.cancel{background:transparent;border:1px solid #466071;color:#d5e1e7}.local-warning{color:#ffd58a}.fine{font-size:13px;color:#9eb1bc;margin:16px 0 0}button:focus-visible{outline:3px solid #67d5b4;outline-offset:2px}
</style></head><body><main class="card"><div class="brand"><img src="/savepoint-icon.svg" alt=""><span>Savepoint</span></div>
<h1>Continue with Google</h1><p>Sign in to connect Claude to your Savepoint projects.</p>
<section class="details"><p><strong>${name}</strong> is requesting access to Savepoint.</p><p>${domain}</p><p>Permission: ${scopes}</p><p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${loopback}</section>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><div class="actions"><button class="button google" name="decision" value="approve">Continue with Google</button><button class="button cancel" name="decision" value="deny">Cancel</button></div></form>
<p class="fine">Savepoint will not receive your Google password. You can revoke Claude’s access in your connector settings.</p></main></body></html>`;
}

function errorPage(message: string, status = 400): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Savepoint sign-in</title><main><h1>Savepoint sign-in failed</h1><p>${escapeHtml(message)}</p><p>Close this tab and reconnect Savepoint in Claude to try again.</p></main>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff" },
  });
}

async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return errorPage("Google sign-in is not configured for this Savepoint server yet.", 503);
  }
  try {
    if (req.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      consent.headers.set("cache-control", "no-store");
      consent.headers.set("referrer-policy", "no-referrer");
      consent.headers.set("x-content-type-options", "nosniff");
      consent.headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      return new Response(loginPage(details, consent.handle), { status: 200, headers: consent.headers });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(req, handle, { scope: [SAVEPOINT_SCOPE] });
    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const verifier = base64Url(verifierBytes);
    const { state, headers } = await oauth.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });
    const callback = `${originFor(req, env)}/oauth/google/callback`;
    const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    google.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: callback,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    headers.set("location", google.toString());
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return errorPage(error.description, 400);
    throw error;
  }
}

async function handleGoogleCallback(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return errorPage("Google sign-in is not configured.", 503);
  try {
    const resumed = await oauth.finishUpstream<{ verifier: string }>(req);
    const url = new URL(req.url);
    if (url.searchParams.has("error")) {
      const target = authorizationErrorRedirect(resumed.request, "access_denied");
      resumed.headers.set("location", target);
      return new Response(null, { status: 302, headers: resumed.headers });
    }
    const code = url.searchParams.get("code");
    if (!code || !resumed.data?.verifier) return errorPage("Google did not return a sign-in code.");

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${originFor(req, env)}/oauth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: resumed.data.verifier,
      }),
    });
    if (!tokenResponse.ok) return errorPage("Google could not complete sign-in. Check the OAuth client configuration and callback URL.", 502);
    const tokens = await tokenResponse.json() as { access_token?: string; token_type?: string };
    if (!tokens.access_token || tokens.token_type?.toLowerCase() !== "bearer") return errorPage("Google returned an invalid sign-in response.", 502);

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileResponse.ok) return errorPage("Savepoint could not verify your Google account.", 502);
    const profile = await profileResponse.json() as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
    if (!profile.sub || !profile.email || profile.email_verified !== true) return errorPage("Use a Google account with a verified email address.", 403);

    const { redirectTo } = await oauth.completeAuthorization({
      request: resumed.request,
      userId: `google_${profile.sub}`,
      metadata: { email: profile.email, name: profile.name ?? "" },
      scope: resumed.request.scope,
      props: { googleSub: profile.sub, email: profile.email, name: profile.name ?? "" },
    });
    resumed.headers.set("location", redirectTo);
    resumed.headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers: resumed.headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return errorPage(error.description, 400);
    throw error;
  }
}

async function rateLimited(req: Request, env: Env): Promise<boolean> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_MIN ?? "120");
  const window = Math.floor(Date.now() / 60000);
  const key = `${ip}:${window}`;
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count"
  ).bind(key, window).first<{ count: number }>();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(window - 5).run();
  return (row?.count ?? 0) > limit;
}

const mcpHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const auth = ctx as OAuthResourceContext<{ legacy?: boolean }>;
    if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (auth.props?.legacy !== true && !auth.auth.scope.includes(SAVEPOINT_SCOPE)) {
      return withCors(new Response("Insufficient scope", { status: 403 }));
    }
    if (req.method === "GET") return withCors(new Response("SSE stream not supported", { status: 405 }));
    if (req.method === "DELETE") return withCors(new Response(null, { status: 200 }));
    if (req.method !== "POST") return withCors(new Response("Method not allowed", { status: 405 }));
    if (await rateLimited(req, env)) return withCors(new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } }));
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return withCors(new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: { "content-type": "application/json" } }));
    }
    return withCors(await handleMcp(env, body, { origin: originFor(req, env) }));
  },
};

const defaultHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (req.method === "GET") {
      if (url.pathname === "/savepoint-icon.svg") return publicIcon();
      const sitePage = publicPage(url.pathname);
      if (sitePage) return sitePage;
    }
    if (url.pathname === "/health") {
      return withCors(new Response("savepoint-mcp is running. MCP endpoint: /mcp", { status: 200 }));
    }
    if (url.pathname === "/authorize") return handleAuthorize(req, env);
    if (url.pathname === "/oauth/google/callback") return handleGoogleCallback(req, env);
    if (url.pathname.startsWith("/dl/")) {
      if (req.method !== "GET") return withCors(new Response("Method not allowed", { status: 405 }));
      if (await rateLimited(req, env)) return withCors(new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } }));
      return withCors(await handleDownload(env, url.pathname.slice(4)));
    }
    return withCors(new Response("Not found", { status: 404 }));
  },
};

const providerCache = new Map<string, OAuthProvider<Env>>();
function createProvider(origin: string): OAuthProvider<Env> {
  const resource = `${origin}/mcp`;
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [SAVEPOINT_SCOPE],
    requiredScopes: [SAVEPOINT_SCOPE],
    resourceMetadata: { resource, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "Savepoint MCP" },
    resolveExternalToken: async ({ token, env: tokenEnv }) => {
      const accepted = !!tokenEnv.ACCESS_KEY && token === tokenEnv.ACCESS_KEY;
      if (!accepted) return null;
      return { audience: resource, props: { legacy: true } };
    },
  });
}

function getProvider(env: Env, req: Request): OAuthProvider<Env> {
  // Bind OAuth metadata and tokens to one canonical host. This is also needed
  // by Wrangler local, which can retain a configured custom-domain host in the
  // Request URL even when serving on 127.0.0.1.
  const origin = originFor(req, env);
  let provider = providerCache.get(origin);
  if (!provider) {
    try {
      provider = createProvider(origin);
    } catch (error) {
      throw new Error(`OAuth provider configuration failed for origin ${origin}: ${String(error)}`);
    }
    providerCache.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = originFor(req, env);
    const requestUrl = new URL(req.url);
    if (requestUrl.origin !== origin) {
      requestUrl.protocol = new URL(origin).protocol;
      requestUrl.host = new URL(origin).host;
    }
    const providerRequest = requestUrl.href === req.url ? req : new Request(requestUrl, req);
    // Keep the existing shared-key connector working while users migrate to OAuth.
    // OAuthProvider's external-token adapter remains configured as a second path.
    const bearer = providerRequest.headers.get("authorization")?.match(/^Bearer[\t ]+([^\s,]+)$/i)?.[1];
    if (requestUrl.pathname === "/mcp" && env.ACCESS_KEY && bearer === env.ACCESS_KEY) {
      return mcpHandler.fetch(providerRequest, env, { props: { legacy: true } } as OAuthResourceContext<{ legacy?: boolean }>);
    }
    return getProvider(env, req).fetch(providerRequest, env, ctx);
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const provider = createProvider((env.PUBLIC_ORIGIN || "https://mcp.14technologies.com.pk").replace(/\/+$/, ""));
    ctx.waitUntil(Promise.all([
      cleanup(env).then((r) => console.log("cleanup", JSON.stringify(r))),
      provider.purgeExpiredData(env).then((r) => console.log("oauth cleanup", JSON.stringify(r))),
    ]).then(() => undefined));
  },
};
