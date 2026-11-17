// Creates .env from .env.example with fresh random secrets and an admin password, and prints the password
// once. Refuses to overwrite an existing .env.
//   node scripts/init-env.ts [--demo] [--locale en] [--port 127.0.0.1:3300] [--llm-key <key>]
// --demo sets DEMO_SEED=true: invented demo content and the built-in demo model, no key needed.
// --locale en sets SITE_LOCALE=en (English site and demo content) and prints in English.
// --port sets PORT, the one place the site's port lives; the site address follows it.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
// A relative import: init-env runs in a fresh clone before `npm ci`, so no workspace package resolves.
import { publishedPort, siteAddress } from "../packages/contracts/src/address.ts";

const password = randomBytes(12).toString("base64url");
const keyAt = process.argv.indexOf("--llm-key");
const llmKey = keyAt > 0 ? (process.argv[keyAt + 1] ?? "") : "";
const portAt = process.argv.indexOf("--port");
const port = portAt > 0 ? (process.argv[portAt + 1] ?? "") : "";
if (portAt > 0 && !publishedPort(port)) {
  console.error(`--port: "${port}" is not a port (3300) or address:port (127.0.0.1:3300).`);
  process.exit(1);
}
const demo = process.argv.includes("--demo");
const localeAt = process.argv.indexOf("--locale");
const locale = localeAt > 0 ? (process.argv[localeAt + 1] ?? "") : "";
if (localeAt > 0 && locale !== "en" && locale !== "zh-CN") {
  console.error(`--locale: "${locale}" is not en or zh-CN.`);
  process.exit(1);
}
const zh = locale !== "en";
const text = readFileSync(".env.example", "utf8")
  .replace(/^ADMIN_PASSWORD=$/m, `ADMIN_PASSWORD=${password}`)
  .replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${randomBytes(32).toString("hex")}`)
  .replace(/^IMG_PROXY_SIGN_SECRET=$/m, `IMG_PROXY_SIGN_SECRET=${randomBytes(32).toString("hex")}`)
  .replace(/^KEY_ENCRYPTION_SECRET=$/m, `KEY_ENCRYPTION_SECRET=${randomBytes(32).toString("hex")}`)
  .replace(/^POSTGRES_PASSWORD=$/m, `POSTGRES_PASSWORD=${randomBytes(18).toString("hex")}`)
  .replace(/^LLM_API_KEY=$/m, `LLM_API_KEY=${llmKey}`)
  .replace(/^PORT=.*$/m, (line) => (port ? `PORT=${port}` : line))
  .replace(/^DEMO_SEED=.*$/m, (line) => (demo ? "DEMO_SEED=true" : line))
  .replace(/^# SITE_LOCALE=.*$/m, (line) => (locale ? `SITE_LOCALE=${locale}` : line));
const portLine = /^PORT=(.*)$/m.exec(text)?.[1];
try {
  // "wx": create only, in the same call that writes, so an .env that appears meanwhile is never overwritten.
  writeFileSync(".env", text, { mode: 0o600, flag: "wx" });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  console.error(zh
    ? ".env 已经存在，没有覆盖（里面的密码和密钥保持不变）。要重新生成，先把它改名或删掉；只改端口就直接编辑其中的 PORT 行。"
    : ".env already exists and was left as it is (its passwords and secrets are unchanged). To generate a new one, rename or delete it first; to change only the port, edit its PORT line.");
  process.exit(1);
}
const address = siteAddress({ PORT: portLine }, "http://localhost:3000");
if (zh) {
  console.log(`已生成 .env。网站地址：${address}（改端口就改 .env 里的 PORT）`);
  console.log(`管理员密码：${password}（也写在 .env 的 ADMIN_PASSWORD 里）`);
  if (demo) console.log("演示：DEMO_SEED=true，启动时写入演示数据；没接模型时「对话」由内置演示模型回答。");
  if (!llmKey) console.log("模型：LLM_API_KEY 还空着。接免费模型或本地 Ollama 见 docs/self-hosting.md#model-connection。");
} else {
  console.log(`Created .env. Site address: ${address} (change the port with PORT in .env)`);
  console.log(`Admin password: ${password} (also in .env as ADMIN_PASSWORD)`);
  if (demo) console.log("Demo: DEMO_SEED=true. Startup loads the demo content; until a model is connected, the built-in demo model answers in Chat.");
  if (!llmKey) console.log("Model: LLM_API_KEY is empty. Free models and local Ollama: docs/self-hosting.md#model-connection.");
}
