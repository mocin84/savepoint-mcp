// Unambiguous alphabet (no 0/O, 1/I/L): 31 chars
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateCode(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const b of bytes) raw += ALPHABET[b % ALPHABET.length];
  return raw.match(/.{5}/g)!.join("-"); // XXXXX-XXXXX-XXXXX-XXXXX (~99 bits)
}

export function normalizeCode(input: string): string {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidCode(normalized: string): boolean {
  return normalized.length === 20;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cleanName(name: unknown): string {
  const s = String(name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  return s || "Untitled project";
}

export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function toInt(v: unknown, def: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

// Returns an error message, or null when the path is valid.
export function validatePath(p: unknown): string | null {
  if (typeof p !== "string" || !p) return "path is required";
  if (p.length > 200) return "path too long (max 200 chars)";
  if (p.startsWith("/")) return "path must be relative (no leading /)";
  if (p.includes("\\")) return "use / not \\ in paths";
  if (/[\u0000-\u001f\u007f]/.test(p)) return "path has control characters";
  if (p.endsWith("/")) return "path must be a file, not a folder";
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return "path has empty, '.' or '..' segments";
  return null;
}

/** 40 hex chars (160 bits): secret token for download links. */
export function randomToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Safe ASCII file name for Content-Disposition. */
export function safeFileName(name: string): string {
  const s = String(name ?? "").replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 60);
  return (s || "project") + ".zip";
}
