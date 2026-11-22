// Sign-up register and the admin-only Excel export.
//
// Every successful Google sign-in upserts one row per Google account. The admin
// downloads the list at /admin/users.xlsx after signing in with Google; only
// emails listed in the ADMIN_EMAILS secret (comma-separated) get the file.
import { zipSync, strToU8 } from "fflate";
import type { Env } from "./index";

const ADMIN_STATE_PREFIX = "admin.";
const ADMIN_COOKIE = "__Host-sp-admin";
const ADMIN_TTL_SECONDS = 600;

const USERS_TABLE = `CREATE TABLE IF NOT EXISTS users (
  google_sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  sign_ins INTEGER NOT NULL DEFAULT 1
)`;

export type GoogleProfile = { sub: string; email: string; name: string };

/** Records a sign-in. Never throws: a logging problem must not block sign-in. */
export async function recordSignIn(env: Env, p: GoogleProfile): Promise<void> {
  try {
    const now = Date.now();
    await env.DB.prepare(USERS_TABLE).run();
    await env.DB.prepare(
      `INSERT INTO users (google_sub, email, name, first_seen, last_seen, sign_ins) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, last_seen = excluded.last_seen, sign_ins = sign_ins + 1`
    )
      .bind(p.sub, p.email, p.name.slice(0, 200), now, now)
      .run();
  } catch (e) {
    console.log("recordSignIn failed", String(e));
  }
}

function adminEmails(env: Env): string[] {
  return String(env.ADMIN_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const isAdminState = (state: string | null): boolean => !!state && state.startsWith(ADMIN_STATE_PREFIX);

/** GET /admin/users.xlsx: send the admin to Google, bound to this browser by a cookie. */
export async function startAdminExport(req: Request, env: Env, origin: string, page: (msg: string, status: number) => Response): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return page("Google sign-in is not configured.", 503);
  if (adminEmails(env).length === 0) return page("The admin export is not set up yet. Set the ADMIN_EMAILS secret.", 503);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256(token);
  await env.OAUTH_KV.put(`admin-export:${hash}`, verifier, { expirationTtl: ADMIN_TTL_SECONDS });
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/oauth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state: ADMIN_STATE_PREFIX + token,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: google.toString(),
      "cache-control": "no-store",
      "set-cookie": `${ADMIN_COOKIE}=${hash}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_TTL_SECONDS}`,
    },
  });
}

/** Google callback for the admin flow: verify the browser, the account, then return the workbook. */
export async function finishAdminExport(
  req: Request,
  env: Env,
  exchange: (code: string, verifier: string) => Promise<GoogleProfile | string>,
  page: (msg: string, status: number) => Response
): Promise<Response> {
  const url = new URL(req.url);
  const token = (url.searchParams.get("state") ?? "").slice(ADMIN_STATE_PREFIX.length);
  const hash = await sha256(token);
  const bound = readCookie(req, ADMIN_COOKIE);
  if (!token || !bound || bound !== hash) return page("This download was not started in this browser. Open /admin/users.xlsx again.", 400);
  const key = `admin-export:${hash}`;
  const verifier = await env.OAUTH_KV.get(key);
  if (!verifier) return page("This download link expired. Open /admin/users.xlsx again.", 400);
  await env.OAUTH_KV.delete(key);
  const code = url.searchParams.get("code");
  if (!code) return page("Google sign-in was cancelled.", 400);
  const profile = await exchange(code, verifier);
  if (typeof profile === "string") return page(profile, 502);
  if (!adminEmails(env).includes(profile.email.toLowerCase())) return page("This Google account is not allowed to download the user list.", 403);

  await env.DB.prepare(USERS_TABLE).run();
  const rows = (
    await env.DB.prepare("SELECT name, email, first_seen, last_seen, sign_ins FROM users ORDER BY first_seen").all<UserRow>()
  ).results;
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(usersWorkbook(rows), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="savepoint-users-${stamp}.xlsx"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "set-cookie": `${ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

// ---------- minimal .xlsx writer (Office Open XML in a zip) ----------

export type UserRow = { name: string; email: string; first_seen: number; last_seen: number; sign_ins: number };

const xml = (s: string) =>
  String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Excel serial date (days since 1899-12-30, UTC). */
const excelDate = (ms: number) => ms / 86400000 + 25569;

function colName(i: number): string {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

export function usersWorkbook(rows: UserRow[]): Uint8Array {
  const header = ["Name", "Email", "First sign-in (UTC)", "Last sign-in (UTC)", "Sign-ins"];
  const cell = (c: number, r: number, v: string | number, style: number, kind: "s" | "n") =>
    kind === "s"
      ? `<c r="${colName(c)}${r}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`
      : `<c r="${colName(c)}${r}" s="${style}"><v>${v}</v></c>`;
  const lines = [`<row r="1">${header.map((h, c) => cell(c, 1, h, 1, "s")).join("")}</row>`];
  rows.forEach((u, i) => {
    const r = i + 2;
    lines.push(
      `<row r="${r}">${cell(0, r, u.name ?? "", 0, "s")}${cell(1, r, u.email, 0, "s")}` +
        `${cell(2, r, excelDate(u.first_seen), 2, "n")}${cell(3, r, excelDate(u.last_seen), 2, "n")}${cell(4, r, u.sign_ins, 0, "n")}</row>`
    );
  });
  const last = Math.max(1, rows.length + 1);
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="36" customWidth="1"/><col min="3" max="4" width="22" customWidth="1"/><col min="5" max="5" width="10" customWidth="1"/></cols>` +
    `<sheetData>${lines.join("")}</sheetData><autoFilter ref="A1:E${last}"/></worksheet>`;
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE0242B"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="Users" sheetId="1" r:id="rId1"/></sheets>` +
        `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Users!$A$1:$E$${last}</definedName></definedNames></workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    "xl/styles.xml": strToU8(styles),
  };
  return zipSync(files, { level: 6 });
}
