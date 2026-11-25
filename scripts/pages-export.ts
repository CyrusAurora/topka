// Writes the online demo's data (docs/online-demo.md): one reader's fixed daily issues, whitelisted
// and leak-scanned, as static JSON for apps/web/demo. Read-only on the database; prints no content,
// only counts, so its log is safe to keep.
//   node --env-file=.env scripts/pages-export.ts --out DIR [--reader EMAIL] [--limit 30] [--deny FILE]
// The reader is --reader or PAGES_DEMO_READER (an email; never printed). --deny is a deny list (one
// term per line, # comments), e.g. the one the public export uses (OSS_DENYLIST).
// Exit 0 written, 1 refused (leak scan or no issue), 2 usage.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@topka/backend/db";
import { leakScan, pagesFiles, readPagesSource } from "@topka/backend/site/pages-export";

const USAGE = "usage: pages-export.ts --out DIR [--reader EMAIL] [--limit N] [--deny FILE]";
let values;
try {
  ({ values } = parseArgs({ args: process.argv.slice(2), options: { out: { type: "string" }, reader: { type: "string" }, limit: { type: "string" }, deny: { type: "string" } }, strict: true, allowPositionals: false }));
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}
const reader = (values.reader ?? process.env.PAGES_DEMO_READER ?? "").trim();
const limit = Number(values.limit ?? 30);
if (!values.out || !reader || !Number.isInteger(limit) || limit < 1 || limit > 365) {
  console.error(`${USAGE}\n(the reader comes from --reader or PAGES_DEMO_READER; --limit is 1–365)`);
  process.exit(2);
}
const denyFile = values.deny ?? process.env.OSS_DENYLIST ?? "";
const denyTerms = denyFile && existsSync(denyFile)
  ? readFileSync(denyFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : [];

try {
  const [user] = await sql<{ id: string; email: string }[]>`SELECT id, email FROM users WHERE email = ${reader}`;
  if (!user) {
    console.error("pages-export: no such reader");
    process.exit(1);
  }
  const src = await readPagesSource(user.id, { limit });
  const files = pagesFiles(src);
  const text: Record<string, string> = {};
  for (const [path, value] of Object.entries(files)) text[path] = `${JSON.stringify(value, null, 1)}\n`;
  // Everything private the rows carried: none of it may appear in what is published.
  // The email's local part too, unless it is too short to mean anything or is the export's own word
  // ("demo", which every alias carries).
  const local = user.email.split("@")[0]!;
  const secrets = [
    user.email, user.id, ...(local.length >= 5 && !/^demo/i.test(local) ? [local] : []),
    ...src.projects.flatMap((p) => [p.id, p.slug]),
    ...src.issues.flatMap((i) => i.items.flatMap((it) => [it.id, it.project.id, it.project.slug])),
  ];
  const problems = leakScan(text, [...new Set(secrets)], denyTerms);
  if (problems.length) {
    console.error(`pages-export: refused, ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  if (!(files["meta.json"] as { latestIssueDate: string | null }).latestIssueDate) {
    console.error("pages-export: the reader has no non-empty issue yet");
    process.exit(1);
  }
  // Written beside the target, then swapped in: a reader of the directory never sees half an export.
  const out = resolve(values.out);
  const tmp = `${out}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const [path, body] of Object.entries(text)) {
    mkdirSync(dirname(join(tmp, path)), { recursive: true });
    writeFileSync(join(tmp, path), body);
  }
  rmSync(out, { recursive: true, force: true });
  renameSync(tmp, out);
  const meta = files["meta.json"] as { latestIssueDate: string; issueCount: number };
  console.log(`pages-export: ${meta.issueCount} issues, latest ${meta.latestIssueDate}, ${Object.keys(text).length} files, leak scan clean (${denyTerms.length} deny-list terms)`);
} finally {
  await closeDb();
}
