import {
  AuthorizationError,
  OAuthProvider,
  authorizationErrorRedirect,
  type OAuthHelpers,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { handleMcp } from "./mcp";
import { cleanup, handleDownload } from "./downloads";
import { cleanupLinks, handleAsset, handleUpload } from "./assets";
import { publicIcon, publicPage } from "./site";
import { markSvg, wordmark } from "./brand";
import { finishAdminExport, isAdminState, recordSignIn, startAdminExport, type GoogleProfile } from "./admin";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  ACCESS_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ADMIN_EMAILS?: string;
  PUBLIC_ORIGIN?: string;
  MAX_PROJECTS_PER_DAY?: string;
  RATE_LIMIT_PER_MIN?: string;
  EXPIRY_HOURS?: string;
  MAX_PROJECT_BYTES?: string;
  MAX_FILES?: string;
  MAX_FILE_BYTES?: string;
  MAX_ASSET_BYTES?: string;
  GLOBAL_STORAGE_BYTES?: string;
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

// Shared look for the sign-in pages. Matches the public site's palette and
// needs no external resources, so it works under the strict page CSP.
const AUTH_STYLE = `
:root{color-scheme:light dark;--paper:#f7f7f8;--card:#fff;--ink:#12171d;--muted:#5b6470;--line:#e3e4e8;--soft:#f6f6f7;--mint:#e0242b;--warn-bg:#fff6e5;--warn-ink:#7a4d00;--btn-border:#747775;--btn-ink:#1f1f1f;--btn-bg:#fff;--btn-hover:#f6f8f7;--shadow:0 1px 2px #12171d0d,0 12px 40px #12171d14;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--paper:#0e1115;--card:#161b21;--ink:#eceef1;--muted:#a3aab3;--line:#2a313a;--soft:#12161b;--mint:#ff5359;--warn-bg:#2d2411;--warn-ink:#f3cf87;--btn-border:#8e918f;--btn-ink:#e3e3e3;--btn-bg:#131314;--btn-hover:#1d1e20;--shadow:0 12px 40px #0006}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--paper);color:var(--ink);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:36px 32px 28px}
.brand{display:flex;align-items:center;gap:10px}.brand .logo{width:36px;height:36px;flex:none}.wordmark{font-weight:750;font-size:17px;letter-spacing:-.02em}
h1{font-size:22px;line-height:1.3;font-weight:650;margin:28px 0 6px;letter-spacing:-.01em}.lead{color:var(--muted);margin:0 0 24px}
.details{list-style:none;margin:0 0 24px;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--soft)}
.details li{display:flex;justify-content:space-between;gap:16px;padding:11px 14px;font-size:14px}.details li+li{border-top:1px solid var(--line)}
.details .k{color:var(--muted);flex:none}.details .v{text-align:right;font-weight:550;overflow-wrap:anywhere}.tag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:11.5px;font-weight:550;color:var(--muted);border:1px solid var(--line)}
.warn{margin:-8px 0 20px;padding:10px 12px;border-radius:10px;background:var(--warn-bg);color:var(--warn-ink);font-size:13.5px}
.actions{display:grid;gap:10px}
.gbtn{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:44px;padding:0 16px;border-radius:999px;border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--btn-ink);font:inherit;font-weight:550;font-size:15px;cursor:pointer;transition:background .15s}
.gbtn:hover{background:var(--btn-hover)}.gbtn svg{width:18px;height:18px;flex:none}
.cancel{height:40px;border:0;border-radius:999px;background:transparent;color:var(--muted);font:inherit;font-size:14px;cursor:pointer}.cancel:hover{color:var(--ink);background:var(--soft)}
button:focus-visible{outline:2px solid var(--mint);outline-offset:3px}
.fine{margin:20px 0 0;padding-top:18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted);display:flex;gap:8px;align-items:flex-start}.fine svg{flex:none;width:14px;height:14px;margin-top:2px;color:var(--mint)}
footer{margin-top:20px;font-size:12.5px;color:var(--muted)}footer a{color:inherit;text-decoration:none;margin:0 8px}footer a:hover{color:var(--ink);text-decoration:underline}
.err-icon{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--warn-bg);color:var(--warn-ink);margin-top:28px}.err-icon svg{width:22px;height:22px}
.err h1{margin-top:16px}.steps{margin:0;padding-left:20px;color:var(--muted);font-size:14px}.steps li+li{margin-top:4px}
@media (max-width:420px){.card{padding:28px 20px 22px;border-radius:14px}}`;

const GOOGLE_G = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
const LOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

function authShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · SavePoint</title><link rel="icon" href="/savepoint-icon.svg"><style>${AUTH_STYLE}</style></head>
<body><main class="card"><div class="brand">${markSvg("logo", "var(--ink)")}${wordmark("var(--ink)")}</div>${body}</main>
<footer><a href="/">Home</a>·<a href="/privacy">Privacy</a>·<a href="/terms">Terms</a></footer></body></html>`;
}

function loginPage(details: Awaited<ReturnType<OAuthHelpers["describeConsent"]>>, handle: string): string {
  const name = escapeHtml(details.clientName);
  const verified = details.clientDomain
    ? `<span class="tag">${escapeHtml(details.clientDomain)}</span>`
    : `<span class="tag" title="This app registered itself; its name is not verified.">unverified</span>`;
  const loopback = details.redirectIsLoopback
    ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started this sign-in.</p>'
    : "";
  return authShell("Sign in", `
<h1>Sign in to SavePoint</h1><p class="lead">${name} wants to connect to your SavePoint projects.</p>
<ul class="details">
<li><span class="k">Requested by</span><span class="v">${name}${verified}</span></li>
<li><span class="k">Access</span><span class="v">Create, read and update your projects</span></li>
<li><span class="k">Returns to</span><span class="v">${escapeHtml(details.redirectHost)}</span></li>
</ul>${loopback}
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><div class="actions">
<button class="gbtn" name="decision" value="approve">${GOOGLE_G}<span>Continue with Google</span></button>
<button class="cancel" name="decision" value="deny">Cancel</button></div></form>
<p class="fine">${LOCK}<span>SavePoint never sees your Google password. You can disconnect at any time from Claude’s connector settings.</span></p>`);
}

function errorPage(message: string, status = 400): Response {
  const body = `<div class="err"><div class="err-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg></div>
<h1>Sign-in didn’t complete</h1><p class="lead">${escapeHtml(message)}</p>
<ol class="steps"><li>Close this tab.</li><li>In Claude, open the SavePoint connector and choose <strong>Connect</strong> again.</li><li>Finish sign-in in the window that opens.</li></ol></div>`;
  return new Response(authShell("Sign-in failed", body), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff" },
  });
}

async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return errorPage("Google sign-in is not configured for this SavePoint server yet.", 503);
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
      // Chrome applies form-action to the redirects that follow a form POST, so
      // it must allow Google (approve) and the client's redirect origin (deny).
      const redirectOrigin = new URL(details.redirectUri).origin;
      const formTargets = ["'self'", "https://accounts.google.com", ...(/^https?:\/\//.test(redirectOrigin) ? [redirectOrigin] : [])].join(" ");
      consent.headers.set("content-security-policy", `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action ${formTargets}; base-uri 'none'; frame-ancestors 'none'`);
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

/** Exchanges a Google code for a verified profile. Returns an error message on failure. */
async function googleProfile(req: Request, env: Env, code: string, verifier: string): Promise<GoogleProfile | string> {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: `${originFor(req, env)}/oauth/google/callback`,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) return "Google could not complete sign-in. Check the OAuth client configuration and callback URL.";
  const tokens = (await tokenResponse.json()) as { access_token?: string; token_type?: string };
  if (!tokens.access_token || tokens.token_type?.toLowerCase() !== "bearer") return "Google returned an invalid sign-in response.";
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileResponse.ok) return "SavePoint could not verify your Google account.";
  const p = (await profileResponse.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
  if (!p.sub || !p.email || p.email_verified !== true) return "Use a Google account with a verified email address.";
  return { sub: p.sub, email: p.email, name: p.name ?? "" };
}

async function handleGoogleCallback(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return errorPage("Google sign-in is not configured.", 503);
  // The admin export reuses this registered callback; its state is prefixed.
  if (isAdminState(new URL(req.url).searchParams.get("state"))) {
    return finishAdminExport(req, env, (code, verifier) => googleProfile(req, env, code, verifier), errorPage);
  }
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

    const profile = await googleProfile(req, env, code, resumed.data.verifier);
    if (typeof profile === "string") return errorPage(profile, profile.startsWith("Use a Google") ? 403 : 502);
    await recordSignIn(env, profile);

    const { redirectTo } = await oauth.completeAuthorization({
      request: resumed.request,
      userId: `google_${profile.sub}`,
      metadata: { email: profile.email, name: profile.name },
      scope: resumed.request.scope,
      props: { googleSub: profile.sub, email: profile.email, name: profile.name },
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
    if (url.pathname === "/admin/users.xlsx" && req.method === "GET") return startAdminExport(req, env, originFor(req, env), errorPage);
    if (url.pathname.startsWith("/u/")) {
      if (await rateLimited(req, env)) return new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } });
      return handleUpload(req, env, url.pathname.slice(3));
    }
    if (url.pathname.startsWith("/a/") && req.method === "GET") {
      if (await rateLimited(req, env)) return new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } });
      return handleAsset(env, url.pathname.slice(3));
    }
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
    resourceMetadata: { resource, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "SavePoint MCP" },
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
      // OAuth helper cookies are host-only (__Host- cookies). Keep the browser
      // on the canonical host before starting sign-in so Google's callback
      // returns to the host that received the binding cookie.
      if (requestUrl.pathname === "/authorize" || requestUrl.pathname === "/oauth/google/callback" || requestUrl.pathname === "/admin/users.xlsx") {
        requestUrl.protocol = new URL(origin).protocol;
        requestUrl.host = new URL(origin).host;
        return Promise.resolve(Response.redirect(requestUrl.toString(), 308));
      }
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
      cleanupLinks(env).then((n) => console.log("link cleanup", n)),
    ]).then(() => undefined));
  },
};
