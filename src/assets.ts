// Binary assets: videos, images, PDFs, fonts, audio, archives.
//
// Big binaries never travel through Claude's tool calls (that would cost
// millions of tokens). Instead:
//   - save({ upload_folder }) returns a short-lived upload link. Claude's code
//     sandbox can `curl -T file <link>/<name>`, or the user opens the link and
//     picks files in the browser.
//   - read({ path }) on a binary returns a short-lived download link.
// Links are random tokens; only their SHA-256 is stored (D1 table `links`).
import type { Env } from "./index";
import { filesPrefix, limits, type ProjectRow } from "./project";
import { ensureMediaSchema, getMeta, updateNotes, writeFile, type State } from "./files";
import { formatBytes, validatePath } from "./util";
import { markSvg, wordmark } from "./brand";

const UPLOAD_MINUTES = 60;
const ASSET_MINUTES = 30;

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const newToken = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Normalises an upload folder: "" or "assets/renders/". */
export function cleanFolder(folder: unknown): string | null {
  const f = String(folder ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (f === "") return "";
  return validatePath(f) ? null : f + "/";
}

async function createLink(env: Env, kind: "upload" | "asset", projectId: string, path: string, minutes: number): Promise<string> {
  await ensureMediaSchema(env);
  const token = newToken();
  await env.DB.prepare("INSERT INTO links (token_hash, kind, project_id, path, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), kind, projectId, path, Date.now() + minutes * 60_000)
    .run();
  return token;
}

export async function uploadLinkText(env: Env, p: ProjectRow, folder: string, origin: string): Promise<string> {
  const token = await createLink(env, "upload", p.id, folder, UPLOAD_MINUTES);
  const url = `${origin}/u/${token}`;
  const max = formatBytes(limits(env).maxAssetBytes);
  return (
    `upload link (${UPLOAD_MINUTES} min, max ${max} per file, folder "${folder || "/"}"): ${url}\n` +
    `From your code environment: curl -sS -T <file> ${url}/<name>. If the network is blocked, give the user the link to upload in a browser.`
  );
}

export async function assetLinkText(env: Env, p: ProjectRow, path: string, ctype: string, size: number, version: number, origin: string): Promise<string> {
  const token = await createLink(env, "asset", p.id, path, ASSET_MINUTES);
  return `${path} v${version} | binary ${ctype}, ${formatBytes(size)}\ndownload (${ASSET_MINUTES} min): ${origin}/a/${token}`;
}

async function findLink(env: Env, kind: "upload" | "asset", token: string) {
  if (!/^[a-f0-9]{40}$/.test(token)) return null;
  await ensureMediaSchema(env);
  const row = await env.DB.prepare(
    "SELECT l.project_id AS project_id, l.path AS path, l.expires_at AS expires_at, p.name AS name, p.last_activity AS last_activity, p.total_bytes AS total_bytes, p.file_count AS file_count, p.created_at AS created_at FROM links l JOIN projects p ON p.id = l.project_id WHERE l.token_hash = ? AND l.kind = ?"
  )
    .bind(await sha256(token), kind)
    .first<{ project_id: string; path: string; expires_at: number; name: string; last_activity: number; total_bytes: number; file_count: number; created_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  if (Date.now() - row.last_activity > Number(env.EXPIRY_HOURS ?? "12") * 3600_000) return null;
  const project: ProjectRow = {
    id: row.project_id,
    name: row.name,
    created_at: row.created_at,
    last_activity: row.last_activity,
    total_bytes: row.total_bytes,
    file_count: row.file_count,
  };
  return { project, path: row.path };
}

const MIME: Record<string, string> = {
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", gif: "image/gif",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
  pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  zip: "application/zip", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export function mimeFor(name: string, given?: string | null): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (MIME[ext]) return MIME[ext];
  if (given && /^[\w.+-]+\/[\w.+-]+$/.test(given) && !given.startsWith("text/html")) return given;
  return "application/octet-stream";
}

function safeName(name: string): string | null {
  const base = name.split(/[\\/]/).pop()?.trim().replace(/[^\w.\- ()]/g, "_").replace(/\s+/g, "-") ?? "";
  if (!base || base === "." || base === ".." || base.length > 120) return null;
  return base;
}

async function storeUpload(env: Env, project: ProjectRow, folder: string, name: string, body: ReadableStream | Uint8Array, bytes: number, ctype: string) {
  const clean = safeName(name);
  if (!clean) return { ok: false as const, error: `Invalid file name: ${name}` };
  const path = folder + clean;
  const pathErr = validatePath(path);
  if (pathErr) return { ok: false as const, error: pathErr };
  const state: State = { total_bytes: project.total_bytes, file_count: project.file_count };
  const r = await writeFile(env, project.id, state, path, { body, bytes, ctype: mimeFor(clean, ctype) }, undefined);
  if (!r.ok) return { ok: false as const, error: r.error };
  project.total_bytes = state.total_bytes;
  project.file_count = state.file_count;
  await updateNotes(env, project, [
    { key: "log", text: `uploaded ${path} (${mimeFor(clean, ctype)}, ${formatBytes(bytes)})`, mode: "append" },
  ]);
  return { ok: true as const, path, version: r.version, size: bytes };
}

// ---------- routes ----------

const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function uploadPage(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · SavePoint</title><link rel="icon" href="/savepoint-icon.svg"><style>
:root{color-scheme:light dark;--paper:#f7f7f8;--card:#fff;--ink:#12171d;--muted:#5b6470;--line:#e3e4e8;--red:#e0242b;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--paper:#0e1115;--card:#161b21;--ink:#eceef1;--muted:#a3aab3;--line:#2a313a;--red:#ff5359}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--paper);color:var(--ink)}
.card{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 28px}
.brand{display:flex;align-items:center;gap:10px}.brand .logo{width:34px;height:34px}.wordmark{font-weight:750;font-size:17px;letter-spacing:-.02em}
h1{font-size:21px;margin:24px 0 6px}p{color:var(--muted);margin:0 0 18px}code{font-size:13px}
.drop{display:block;border:2px dashed var(--line);border-radius:12px;padding:26px;text-align:center;color:var(--muted);margin-bottom:16px}
input[type=file]{width:100%;margin-top:10px;color:var(--ink)}
button{width:100%;height:44px;border:0;border-radius:999px;background:var(--red);color:#fff;font:inherit;font-weight:650;cursor:pointer}
ul{padding-left:20px;margin:0 0 16px}li{margin:4px 0}.err{color:var(--red)}
</style></head><body><main class="card"><div class="brand">${markSvg("logo", "var(--ink)")}${wordmark("var(--ink)")}</div>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** /u/<token> (GET page, POST form) and /u/<token>/<name> (PUT raw body, for curl). */
export async function handleUpload(req: Request, env: Env, rest: string): Promise<Response> {
  const [token, ...nameParts] = rest.split("/");
  const link = await findLink(env, "upload", token);
  const plain = (msg: string, status: number) => new Response(msg + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (!link) return req.method === "GET" ? uploadPage("Link expired", `<h1>This upload link has expired</h1><p>Ask Claude for a new upload link.</p>`, 404) : plain("Upload link is invalid or expired.", 404);
  const max = limits(env).maxAssetBytes;

  if (req.method === "PUT") {
    const name = decodeURIComponent(nameParts.join("/"));
    const len = Number(req.headers.get("content-length") ?? "NaN");
    if (!name) return plain("Add a file name: PUT /u/<token>/<name>", 400);
    if (!Number.isFinite(len) || len <= 0) return plain("Content-Length is required (curl -T sets it).", 411);
    if (len > max) return plain(`File too large: max ${formatBytes(max)}.`, 413);
    if (!req.body) return plain("Empty body.", 400);
    const r = await storeUpload(env, link.project, link.path, name, req.body, len, req.headers.get("content-type") ?? "");
    return r.ok ? plain(`saved ${r.path} v${r.version} (${formatBytes(r.size)})`, 200) : plain(r.error, 400);
  }

  if (req.method === "POST") {
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > max + 1024 * 1024) return uploadPage("Too large", `<h1>Too large</h1><p class="err">Upload at most ${formatBytes(max)} at a time.</p>`, 413);
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return uploadPage("Upload failed", `<h1>Upload failed</h1><p class="err">The upload could not be read. Try again.</p>`, 400);
    }
    const lines: string[] = [];
    for (const v of form.getAll("file")) {
      if (typeof v === "string" || !v || !v.size) continue;
      const f = v as File;
      const r = await storeUpload(env, link.project, link.path, f.name, new Uint8Array(await f.arrayBuffer()), f.size, f.type);
      lines.push(r.ok ? `<li>Saved <code>${esc(r.path)}</code> (${formatBytes(r.size)})</li>` : `<li class="err">${esc(f.name)}: ${esc(r.error)}</li>`);
    }
    if (!lines.length) lines.push(`<li class="err">No file was selected.</li>`);
    return uploadPage("Uploaded", `<h1>Upload to “${esc(link.project.name)}”</h1><ul>${lines.join("")}</ul><p>Tell Claude the upload is done, or add more files below.</p>${uploadForm(token, max)}`);
  }

  if (req.method === "GET") {
    return uploadPage(
      "Upload files",
      `<h1>Upload to “${esc(link.project.name)}”</h1><p>Files go to <code>${esc(link.path || "/")}</code>. Videos, images, PDFs and other files up to ${formatBytes(max)} each. This link works for about an hour.</p>${uploadForm(token, max)}`
    );
  }
  return plain("Method not allowed", 405);
}

function uploadForm(token: string, max: number): string {
  return `<form method="post" action="/u/${token}" enctype="multipart/form-data"><label class="drop">Choose files (max ${formatBytes(max)} each)<input type="file" name="file" multiple required></label><button type="submit">Upload to SavePoint</button></form>`;
}

/** /a/<token>: download one asset. */
export async function handleAsset(env: Env, token: string): Promise<Response> {
  const link = await findLink(env, "asset", token);
  const gone = () => new Response("This asset link is invalid or has expired. Ask Claude to read the file again.\n", { status: 404, headers: { "cache-control": "no-store" } });
  if (!link) return gone();
  const meta = await getMeta(env, link.project.id, link.path);
  const obj = await env.FILES.get(filesPrefix(link.project.id) + link.path);
  if (!meta || !obj) return gone();
  const name = link.path.split("/").pop() ?? "file";
  return new Response(obj.body, {
    headers: {
      "content-type": meta.ctype ?? "text/plain; charset=utf-8",
      "content-length": String(obj.size),
      "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/** Cron: remove expired links. */
export async function cleanupLinks(env: Env): Promise<number> {
  await ensureMediaSchema(env);
  const r = await env.DB.prepare("DELETE FROM links WHERE expires_at < ?").bind(Date.now()).run();
  return r.meta.changes ?? 0;
}
