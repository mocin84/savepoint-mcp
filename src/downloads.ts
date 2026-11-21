import { zipSync } from "fflate";
import type { Env } from "./index";
import { fail, filesPrefix, findProject, ok, type ToolResult } from "./project";
import { listFiles } from "./files";
import { formatBytes, randomToken, safeFileName } from "./util";

export type Ctx = { origin: string };

const dlKey = (id: string, token: string) => `p/${id}/dl/${token}.zip`;
const dlMs = (env: Env) => Number(env.DOWNLOAD_MINUTES ?? "15") * 60_000;

// ---------- tool: project_download ----------

export async function projectDownload(env: Env, args: any, ctx: Ctx): Promise<ToolResult> {
  const found = await findProject(env, args?.code);
  if (!found.ok) return fail(found.error);
  const { row } = found;
  const now = Date.now();

  // Reuse a still-valid link when nothing changed since it was made (saves work).
  const existing = await env.DB.prepare(
    "SELECT token, expires_at FROM downloads WHERE project_id = ? AND created_at >= ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(row.id, row.last_activity, now + 60_000)
    .first<{ token: string; expires_at: number }>();
  if (existing) return ok(linkText(ctx, existing.token, existing.expires_at - now, row.file_count, row.total_bytes, true));

  let paths = (await env.DB.prepare("SELECT path FROM files WHERE project_id = ? ORDER BY path").bind(row.id).all<{ path: string }>()).results;
  if (paths.length === 0 && row.file_count > 0) {
    await listFiles(env, row, ""); // adopts Phase-1 files into the index
    paths = (await env.DB.prepare("SELECT path FROM files WHERE project_id = ? ORDER BY path").bind(row.id).all<{ path: string }>()).results;
  }

  const data: Record<string, Uint8Array> = {};
  let total = 0;
  try {
    const BATCH = 8;
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH);
      const objs = await Promise.all(chunk.map((p) => env.FILES.get(filesPrefix(row.id) + p.path)));
      for (let j = 0; j < chunk.length; j++) {
        const o = objs[j];
        if (!o) continue; // file row without object (should not happen): skip
        const buf = new Uint8Array(await o.arrayBuffer());
        data[chunk[j].path] = buf;
        total += buf.length;
      }
    }
  } catch (e: any) {
    return fail(`Could not read the project files for the zip (${e?.message ?? "storage error"}). Try again in a moment.`);
  }
  const count = Object.keys(data).length;
  if (count === 0) return fail("Project has no files to download.");

  let zip: Uint8Array;
  try {
    zip = zipSync(data, { level: 0 }); // store mode: no compression, keeps CPU low
  } catch (e: any) {
    return fail(`Could not build the zip (${e?.message ?? "error"}).`);
  }

  const token = randomToken();
  const expires = now + dlMs(env);
  try {
    await env.FILES.put(dlKey(row.id, token), zip, { httpMetadata: { contentType: "application/zip" } });
  } catch {
    return fail("Storage error while preparing the download. Try again.");
  }
  await env.DB.prepare("INSERT INTO downloads (token, project_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(token, row.id, now, expires).run();
  return ok(linkText(ctx, token, expires - now, count, total, false));
}

function linkText(ctx: Ctx, token: string, leftMs: number, files: number, bytes: number, reused: boolean): string {
  const mins = Math.max(1, Math.round(leftMs / 60_000));
  return (
    `Download link (works for about ${mins} min${reused ? ", same link as before, nothing changed" : ""}):\n${ctx.origin}/dl/${token}\n\n` +
    `Zip of ${files} file(s), ${formatBytes(bytes)}. Give this link to the user to open in a browser. ` +
    `The project stays online and its 24h timer is not reset.`
  );
}

// ---------- route: GET /dl/<token> ----------

export async function handleDownload(env: Env, token: string): Promise<Response> {
  const gone = () =>
    new Response("This download link is invalid or has expired. Ask Claude to call project_download again.", { status: 404, headers: { "cache-control": "no-store" } });
  if (!/^[a-f0-9]{40}$/.test(token)) return gone();

  const row = await env.DB.prepare(
    "SELECT d.project_id AS id, d.expires_at AS expires_at, p.name AS name, p.last_activity AS last_activity FROM downloads d JOIN projects p ON p.id = d.project_id WHERE d.token = ?"
  )
    .bind(token)
    .first<{ id: string; expires_at: number; name: string; last_activity: number }>();
  if (!row) return gone();
  const now = Date.now();
  if (row.expires_at < now) return gone();
  if (now - row.last_activity > Number(env.EXPIRY_HOURS ?? "24") * 3600_000) return gone(); // project itself expired

  const obj = await env.FILES.get(dlKey(row.id, token));
  if (!obj) return gone();
  const fname = safeFileName(row.name);
  return new Response(obj.body, {
    headers: {
      "content-type": "application/zip",
      "content-length": String(obj.size),
      "content-disposition": `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
      "cache-control": "no-store",
    },
  });
}

// ---------- cron: cleanup ----------

/**
 * Deletes expired projects (R2 objects + D1 rows), expired zips and old rate-limit rows.
 * Works under a small "subrequest budget" so it also fits free-plan limits; leftovers are done next hour.
 */
export async function cleanup(env: Env): Promise<{ projects: number; zips: number }> {
  const now = Date.now();
  const expiryMs = Number(env.EXPIRY_HOURS ?? "24") * 3600_000;
  let budget = Number(env.CLEANUP_BUDGET ?? "40");
  let projects = 0;
  let zips = 0;

  // 1) expired projects
  const exp = await env.DB.prepare("SELECT id FROM projects WHERE last_activity < ? ORDER BY last_activity LIMIT 50").bind(now - expiryMs).all<{ id: string }>();
  budget--;
  for (const { id } of exp.results) {
    if (budget < 6) break;
    let objectsDeleted = false;
    while (budget > 2) {
      const l = await env.FILES.list({ prefix: `p/${id}/`, limit: 1000 });
      budget--;
      if (l.objects.length === 0) {
        objectsDeleted = true;
        break;
      }
      await env.FILES.delete(l.objects.map((o) => o.key));
      budget--;
      if (!l.truncated) {
        objectsDeleted = true;
        break;
      }
    }
    // Keep the expired D1 rows so the next cron run can resume deleting R2
    // pages. Deleting the project row here would orphan any objects remaining
    // after the per-invocation cleanup budget is exhausted.
    if (!objectsDeleted) break;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM files WHERE project_id = ?").bind(id),
      env.DB.prepare("DELETE FROM downloads WHERE project_id = ?").bind(id),
      env.DB.prepare("DELETE FROM projects WHERE id = ? AND last_activity < ?").bind(id, now - expiryMs),
    ]);
    budget--;
    projects++;
  }

  // 2) expired download zips of projects that are still alive
  if (budget >= 4) {
    const old = await env.DB.prepare("SELECT token, project_id FROM downloads WHERE expires_at < ? LIMIT 100").bind(now).all<{ token: string; project_id: string }>();
    budget--;
    if (old.results.length) {
      await env.FILES.delete(old.results.map((d) => dlKey(d.project_id, d.token)));
      budget--;
      await env.DB.batch(old.results.map((d) => env.DB.prepare("DELETE FROM downloads WHERE token = ?").bind(d.token)));
      budget--;
      zips = old.results.length;
    }
  }

  // 3) old rate-limit windows
  await env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(Math.floor(now / 60000) - 5).run();
  return { projects, zips };
}
