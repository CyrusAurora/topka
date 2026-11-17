// Re-checks an online-demo data directory before it is published (the Pages workflow runs it on the
// pages-data branch): only the expected file names, valid JSON, and nothing the leak scan refuses.
//   node scripts/pages-check.ts DIR      exit 0 clean (or no data yet), 1 refused
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { leakScan } from "@topka/contracts/pages-scan";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: pages-check.ts DIR");
  process.exit(2);
}
if (!existsSync(dir)) {
  console.log("pages-check: no data directory; the demo builds without data");
  process.exit(0);
}
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (name === ".git") continue;
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(dir, p)] = readFileSync(p, "utf8");
  }
};
walk(dir);
const problems = leakScan(files);
for (const [path, text] of Object.entries(files)) {
  try {
    JSON.parse(text);
  } catch {
    problems.push(`${path}: not JSON`);
  }
}
if (problems.length) {
  console.error(`pages-check: refused, ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`pages-check: ${Object.keys(files).length} files clean`);
