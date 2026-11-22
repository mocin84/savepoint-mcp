// Smoke test for a running server. Usage: node scripts/smoke.mjs [baseUrl]
// Local:  npx wrangler d1 execute savepoint-db --local --config wrangler.local.toml --file=schema.sql
//         npx wrangler dev --local --config wrangler.local.toml --port 8787 --var MAX_FILES:8
//         SMOKE_MAXFILES=8 node scripts/smoke.mjs
import { unzipSync } from "fflate";

const BASE = (process.argv[2] || "http://localhost:8787") + "/mcp";
const BASEURL = new URL(BASE).origin;
const ACCESS_KEY = process.env.SMOKE_ACCESS_KEY || "local-test-key";
let id = 0, pass = 0, failn = 0;

async function rpc(method, params) {
  const r = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ACCESS_KEY}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  return r.json();
}
async function tool(name, args) {
  const j = await rpc("tools/call", { name, arguments: args });
  const res = j.result;
  return { text: res.content[0].text, isError: !!res.isError };
}
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { failn++; console.log("  FAIL " + label + (extra ? "\n       " + String(extra).slice(0, 300) : "")); }
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
check("initialize v0.3.0", init.result?.serverInfo?.version === "0.3.0");
const iconInit = await rpc("initialize", { protocolVersion: "2025-11-25" });
check("initialize advertises Savepoint icon", iconInit.result?.serverInfo?.title === "Savepoint" && iconInit.result?.serverInfo?.icons?.[0]?.src?.startsWith("data:image/svg+xml,"));
check("instructions require continue box in first reply", init.result?.instructions?.includes("first user-facing reply MUST include the continue box"));
const health = await fetch(BASEURL + "/health");
check("health is public", health.status === 200);
const unauth = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 90001, method: "initialize" }) });
check("unauthenticated MCP request starts OAuth", unauth.status === 401 && /oauth-protected-resource/.test(unauth.headers.get("www-authenticate") || ""));
const wrongAuth = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer invalid-test-key" }, body: JSON.stringify({ jsonrpc: "2.0", id: 90002, method: "initialize" }) });
check("invalid bearer is rejected", wrongAuth.status === 401);
const metadata = await fetch(BASEURL + "/.well-known/oauth-protected-resource/mcp");
const metadataJson = await metadata.json();
check("OAuth resource metadata is discoverable", metadata.status === 200 && metadataJson.resource?.endsWith("/mcp"));
const authMetadata = await fetch(BASEURL + "/.well-known/oauth-authorization-server");
const authMetadataJson = await authMetadata.json();
check("OAuth authorization server metadata is discoverable", authMetadata.status === 200 && authMetadataJson.authorization_endpoint?.endsWith("/authorize") && authMetadataJson.token_endpoint?.endsWith("/oauth/token"));
const list = await rpc("tools/list");
const names = list.result.tools.map((t) => t.name);
check("10 tools listed", names.length === 10 && names.includes("project_download"), names.join(","));

const created = await tool("project_create", { name: "Smoke" });
const code = created.text.match(/[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}/)?.[0];
check("project_create returns code", !!code, created.text);
const box = created.text.match(/```\n([\s\S]*?)\n```/);
check("create result has a copyable continue box", !!box && box[1].includes("project_open") && box[1].includes(code) && box[1].includes("NOTES.md"), created.text);
check("create result explicitly requires box in first reply", created.text.includes("FIRST REPLY REQUIREMENT"), created.text);
check("continue box names the Savepoint connector", !!box && box[1].includes("Savepoint connector"), box?.[1]);
check("continue box is short (<= 400 chars)", !!box && box[1].length <= 400, box?.[1]?.length);
check("create result does not push limit/session talk", !/usage limit|next session/i.test(created.text.replace(/Do not mention usage limits or future sessions\./, "")), created.text);

let r = await tool("file_write", { code, path: "src/a.txt", content: "line1\nline2\nline3\n" });
check("file_write new -> v1", !r.isError && r.text.includes("v1"), r.text);
let o = await tool("project_open", { code });
check("file_write automatically updates NOTES.md", o.text.includes("Saved src/a.txt (v1)."), o.text);
r = await tool("file_write", { code, path: "src/a.txt", content: "x" });
check("overwrite without base_version rejected", r.isError && r.text.includes("base_version=1"), r.text);
r = await tool("file_write", { code, path: "src/a.txt", content: "x", base_version: 5 });
check("wrong base_version -> conflict", r.isError && r.text.includes("conflict"), r.text);
r = await tool("file_write", { code, path: "src/a.txt", content: "line1\nline2\nline3\nline4\n", base_version: 1 });
check("overwrite with base_version -> v2", !r.isError && r.text.includes("v2"), r.text);

r = await tool("file_read", { code, path: "src/a.txt" });
check("file_read numbered + version", r.text.includes("v2") && r.text.includes("1| line1") && r.text.includes("lines 1-4 of 4"), r.text);
r = await tool("file_read", { code, path: "src/a.txt", start_line: 2, end_line: 3 });
check("file_read range", r.text.includes("2| line2") && r.text.includes("3| line3") && !r.text.includes("1| line1"), r.text);
r = await tool("file_read", { code, path: "nope.txt" });
check("file_read missing file", r.isError, r.text);

// large file: pagination
const big = Array.from({ length: 900 }, (_, i) => "row " + (i + 1)).join("\n");
r = await tool("file_write", { code, path: "big.txt", content: big });
check("write 900-line file", !r.isError, r.text);
r = await tool("file_read", { code, path: "big.txt" });
check("read caps at 400 lines + continue hint", r.text.includes("lines 1-400 of 900") && r.text.includes("start_line=401"), r.text.slice(0, 120));
r = await tool("file_read", { code, path: "big.txt", start_line: 401 });
check("read next page", r.text.includes("lines 401-800 of 900"), r.text.slice(0, 120));

// edit
r = await tool("file_edit", { code, path: "src/a.txt", old_str: "line2", new_str: "LINE-TWO" });
check("file_edit unique", !r.isError && r.text.includes("v3"), r.text);
o = await tool("project_open", { code });
check("file_edit automatically updates NOTES.md", o.text.includes("Edited src/a.txt (v3)."), o.text);
r = await tool("file_edit", { code, path: "src/a.txt", old_str: "line", new_str: "L" });
check("file_edit ambiguous rejected", r.isError && r.text.includes("more than once"), r.text);
r = await tool("file_edit", { code, path: "src/a.txt", old_str: "zzz", new_str: "L" });
check("file_edit not found rejected", r.isError && r.text.includes("not found"), r.text);
r = await tool("file_edit", { code, path: "src/a.txt", old_str: "line1", new_str: "L1", base_version: 1 });
check("file_edit strict base_version conflict", r.isError && r.text.includes("conflict"), r.text);

// batch write
r = await tool("files_write", { code, files: [{ path: "src/b.js", content: "b" }, { path: "docs/c.md", content: "# c" }] });
check("files_write 2 files", !r.isError && r.text.startsWith("2/2"), r.text);
r = await tool("files_write", { code, files: [{ path: "src/b.js", content: "b2" }, { path: "docs/d.md", content: "d" }] });
check("files_write reports per-file failure", r.isError && r.text.includes("FAIL src/b.js") && r.text.includes("OK   docs/d.md"), r.text);

// list
r = await tool("file_list", { code, prefix: "src/" });
check("file_list prefix", r.text.includes("src/a.txt") && r.text.includes("src/b.js") && !r.text.includes("docs/"), r.text);

// path validation
for (const bad of ["../x", "/x", "a//b", "a/./b", "dir/", "a\\b"]) {
  r = await tool("file_write", { code, path: bad, content: "x" });
  check("bad path rejected: " + JSON.stringify(bad), r.isError, r.text);
}
r = await tool("file_write", { code, path: "huge.txt", content: "x".repeat(1048577) });
check("file > 1MB rejected", r.isError && r.text.includes("too large"), r.text.slice(0, 120));

// race: 5 parallel creates of the same new path -> exactly one wins
const race = await Promise.all(Array.from({ length: 5 }, (_, i) => tool("file_write", { code, path: "race.txt", content: "w" + i })));
check("race: exactly 1 of 5 creates wins", race.filter((x) => !x.isError).length === 1, race.map((x) => x.text).join(" | "));

// parallel notes_update: nothing lost
await Promise.all(Array.from({ length: 5 }, (_, i) => tool("notes_update", { code, section: "done", text: "item-" + i })));
o = await tool("project_open", { code });
check("parallel notes_update keeps all 5", [0, 1, 2, 3, 4].every((i) => o.text.includes("item-" + i)), o.text);
check("placeholder '(nothing yet)' removed", !o.text.includes("(nothing yet)"), o.text);

await tool("notes_update", { code, section: "pending", text: "ship phase 3", mode: "replace" });
await tool("notes_update", { code, section: "log", text: "handed off to account B" });
await tool("notes_update", { code, section: "goal", text: "Smoke goal", mode: "replace" });
o = await tool("project_open", { code });
check("notes pending replaced", o.text.includes("Pending / Next steps\n- ship phase 3\n"), o.text);
check("notes log has timestamp", /- \d{4}-\d{2}-\d{2} \d{2}:\d{2}: handed off to account B/.test(o.text), o.text);
check("notes goal replaced", o.text.includes("Smoke goal"), o.text);
r = await tool("notes_update", { code, section: "bogus", text: "x" });
check("notes_update bad section", r.isError, r.text);

// delete
r = await tool("file_delete", { code, path: "NOTES.md" });
check("NOTES.md delete refused", r.isError, r.text);
r = await tool("file_delete", { code, path: "docs/c.md" });
check("file_delete ok", !r.isError, r.text);
r = await tool("file_list", { code, prefix: "docs/" });
check("deleted file gone from list", !r.text.includes("docs/c.md"), r.text);

// accounting: project_open count must equal file_list count
const all = await tool("file_list", { code });
const nFiles = all.text.split("\n").filter((l) => l.startsWith("- ")).length;
o = await tool("project_open", { code });
check("project file count matches list (" + nFiles + ")", o.text.includes(`Files: ${nFiles},`), o.text.slice(0, 160));

// file-count limit (only when server started with --var MAX_FILES:N)
if (process.env.SMOKE_MAXFILES) {
  let hit = null;
  for (let i = 0; i < 30 && !hit; i++) {
    const w = await tool("file_write", { code, path: `lim/f${i}.txt`, content: "x" });
    if (w.isError) hit = w.text;
  }
  check("file-count limit enforced", !!hit && hit.includes("File limit"), hit);
}


// ---------- Phase 3: download ----------
const minsLeft = (t) => { const m = t.match(/Expires in: (?:(\d+)h )?(\d+)m/); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : -1; };
const before = minsLeft((await tool("project_open", { code })).text);
let d = await tool("project_download", { code });
const link = d.text.match(/https?:\/\/\S+\/dl\/[a-f0-9]{40}/)?.[0];
check("project_download returns link", !d.isError && !!link, d.text);
let zres = await fetch(link);
const zbuf = Buffer.from(await zres.arrayBuffer());
check("download 200 + zip magic", zres.status === 200 && zbuf.subarray(0, 4).toString("hex") === "504b0304", `HTTP ${zres.status}: ${zbuf.toString("utf8").slice(0, 240)}`);
check("download is an attachment .zip", /attachment; filename="Smoke\.zip"/.test(zres.headers.get("content-disposition") || ""), zres.headers.get("content-disposition"));
const zs = zbuf.toString("latin1");
const zipNames = zres.status === 200 ? Object.keys(unzipSync(zbuf)) : [];
check("zip holds files (src/a.txt, src/b.js, NOTES.md)", ["src/a.txt", "src/b.js", "NOTES.md"].every((name) => zipNames.includes(name)), zipNames.join(", "));
check("zip holds file content (store mode)", zs.includes("line1") && zs.includes("Smoke goal"), "");
check("zip excludes deleted file", !zipNames.includes("docs/c.md"), zipNames.join(", "));
const d2 = await tool("project_download", { code });
check("same link reused when nothing changed", d2.text.includes(link), d2.text);
await tool("notes_update", { code, section: "log", text: "zipcheck-marker" }); // a change (project may be at its file limit)
const d3 = await tool("project_download", { code });
const link3 = d3.text.match(/https?:\/\/\S+\/dl\/[a-f0-9]{40}/)?.[0];
check("new link after a change", !!link3 && link3 !== link, d3.text);
check("zip of new link has the change", Buffer.from(await (await fetch(link3)).arrayBuffer()).toString("latin1").includes("zipcheck-marker"), "");
const mid = minsLeft((await tool("project_open", { code })).text);
check("download did not reset 24h timer (writes did, so just sanity)", before > 0 && mid > 0, `${before} ${mid}`);
check("garbage token -> 404", (await fetch(BASEURL + "/dl/" + "0".repeat(40))).status === 404, "");
check("malformed token -> 404", (await fetch(BASEURL + "/dl/abc")).status === 404, "");
check("download needs no access key (plain GET works)", (await fetch(link3)).status === 200, "");
r = await tool("project_download", { code: "AAAAA-AAAAA-AAAAA-AAAAA" });
check("download unknown project -> error", r.isError, r.text);
// download must not touch last_activity: open twice around a download, timer must not go UP
const t1 = minsLeft((await tool("project_open", { code })).text);
await tool("project_download", { code });
const t2 = minsLeft((await tool("project_open", { code })).text);
check("download does not extend timer", t2 <= t1, `${t1} -> ${t2}`);

// bad code / unknown tool
r = await tool("project_open", { code: "AAAAA-AAAAA-AAAAA-AAAAA" });
check("unknown project -> error", r.isError, r.text);
r = await tool("nope_tool", {});
check("unknown tool -> error", r.isError, r.text);

console.log(`\n${pass} passed, ${failn} failed`);
process.exit(failn ? 1 : 0);
