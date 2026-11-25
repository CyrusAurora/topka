// A local stand-in for the alert webhook (docs/alerts.md), for drills and tests: accepts the
// Feishu-style JSON, appends each message to a file as one JSON line, answers {"code":0}.
//   node scripts/mock-webhook.ts --out FILE [--port 0] [--fail N]
// --fail N answers HTTP 500 to the first N messages (to see retries). Prints the address it listens on.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { out: { type: "string" }, port: { type: "string" }, fail: { type: "string" } } });
if (!values.out) { console.error("usage: mock-webhook.ts --out FILE [--port 0] [--fail N]"); process.exit(2); }
let failLeft = Number(values.fail ?? 0);
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
  req.on("end", () => {
    let text: unknown = null;
    try { text = (JSON.parse(body) as { content?: { text?: unknown } }).content?.text ?? null; } catch { /* recorded as raw */ }
    const failed = failLeft > 0;
    if (failed) failLeft--;
    appendFileSync(values.out!, `${JSON.stringify({ at: new Date().toISOString(), path: req.url, status: failed ? 500 : 200, text, raw: text === null ? body.slice(0, 2000) : undefined })}\n`);
    res.writeHead(failed ? 500 : 200, { "content-type": "application/json" });
    res.end(failed ? '{"code":500,"msg":"mock failure"}' : '{"code":0,"msg":"success"}');
  });
});
server.listen(Number(values.port ?? 0), "127.0.0.1", () => {
  const a = server.address();
  console.log(`mock-webhook: listening http://127.0.0.1:${typeof a === "object" && a ? a.port : "?"}/hook`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)));
