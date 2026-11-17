// Builds the online demo (apps/web/demo) into apps/web/build-demo: the static app under --base, the
// exported data (scripts/pages-export.ts) under data/, and a copy of index.html for every page path so
// GitHub Pages answers each with 200 (404.html covers the rest).
//   node scripts/build-demo.ts [--base /topka/] [--data DIR]
// Without --data (or with an empty one) the demo still builds; its pages say there is no data yet.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: process.argv.slice(2), options: { base: { type: "string" }, data: { type: "string" } }, strict: true });
const base = values.base ?? "/";
if (!/^\/([A-Za-z0-9._-]+\/)*$/.test(base)) {
  console.error(`--base must look like / or /topka/ (got ${base})`);
  process.exit(2);
}
const web = resolve(import.meta.dirname, "../apps/web");
const out = join(web, "build-demo");

execFileSync(process.execPath, [join(resolve(import.meta.dirname, ".."), "node_modules/vite/bin/vite.js"), "build", "-c", "vite.demo.config.ts", "--base", base, "--logLevel", "warn"], {
  cwd: web, stdio: "inherit",
});

const dates: string[] = [];
if (values.data && existsSync(values.data)) {
  cpSync(resolve(values.data), join(out, "data"), { recursive: true, filter: (src) => !/(^|\/)\./.test(src.slice(resolve(values.data!).length)) });
  const issues = join(out, "data", "issues");
  if (existsSync(issues)) for (const f of readdirSync(issues)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) dates.push(f.slice(0, 10));
}

const shell = readFileSync(join(out, "index.html"), "utf8");
const pages = ["today", "archive", "chat", "settings", "projects", "projects/new", "about", "feedback", "login", "register", "privacy", "terms", ...dates.map((d) => `issue/${d}`)];
for (const p of pages) {
  mkdirSync(join(out, p), { recursive: true });
  writeFileSync(join(out, p, "index.html"), shell);
}
writeFileSync(join(out, "404.html"), shell);
// Pages serves files as they are (no Jekyll processing).
writeFileSync(join(out, ".nojekyll"), "");
console.log(`demo: built for ${base} with ${dates.length} issue(s) of data, ${pages.length} page shells`);
