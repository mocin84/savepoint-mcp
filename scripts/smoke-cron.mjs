// Cron cleanup test. Needs a server started with a tiny expiry and --test-scheduled:
//   npx wrangler d1 execute savepoint-db --local --config wrangler.local.toml --file=schema.sql
//   npx wrangler dev --local --config wrangler.local.toml --port 8787 --test-scheduled --var EXPIRY_HOURS:0.0006 --var DOWNLOAD_MINUTES:0.02
//   node scripts/smoke-cron.mjs
// (0.0006 h = ~2.2 s project expiry, 0.02 min = 1.2 s download link life)
const ORIGIN = process.argv[2] || "http://localhost:8787";
let id = 0, pass = 0, failn = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tool(name, args) {
  const r = await fetch(ORIGIN + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.SMOKE_ACCESS_KEY || "local-test-key"}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  return { text: res.content[0].text, isError: !!res.isError };
}
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log("  ok   " + label); } else { failn++; console.log("  FAIL " + label + (extra ? "\n       " + String(extra).slice(0, 300) : "")); }
}
const runCron = () => fetch(ORIGIN + "/__scheduled?cron=0+*+*+*+*");

// A: project A (will expire) with a zip
const a = await tool("project_create", { name: "CronA" });
const codeA = a.text.match(/[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}/)[0];
await tool("file_write", { code: codeA, path: "x.txt", content: "hello" });
const dA = await tool("project_download", { code: codeA });
const linkA = dA.text.match(/https?:\/\/\S+\/dl\/[a-f0-9]{40}/)?.[0];
check("A: link made", !!linkA, dA.text);
check("A: link works before expiry", (await fetch(linkA)).status === 200);

await sleep(3500); // project A and its link are now expired
check("A: lazy expiry blocks project_open", (await tool("project_open", { code: codeA })).isError);
check("A: expired link -> 404 even before cron", (await fetch(linkA)).status === 404);

// B: fresh project created after A expired: must survive the cron
const b = await tool("project_create", { name: "CronB" });
const codeB = b.text.match(/[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}/)[0];
const rc = await runCron();
check("cron endpoint ran", rc.status === 200, rc.status);
await sleep(800);
check("B survives cron", !(await tool("project_open", { code: codeB })).isError);
check("A project gone after cron", (await tool("project_open", { code: codeA })).isError);
check("A link still 404", (await fetch(linkA)).status === 404);

console.log(`\n${pass} passed, ${failn} failed`);
process.exit(failn ? 1 : 0);
