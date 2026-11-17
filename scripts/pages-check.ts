// Re-checks an online-demo data directory before it is published (the Pages workflow runs it on the
// pages-data branch): only the expected file names, valid JSON, and nothing the leak scan refuses.
//   node scripts/pages-check.ts DIR      exit 0 clean (or no data yet), 1 refused
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const p = join(d, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile()) files[relative(dir, p)] = readFileSync(p, "utf8");
    else problems.push(`${relative(dir, p)}: not a regular file`);
  }
};
const problems: string[] = [];
walk(dir);
problems.push(...leakScan(files));
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
