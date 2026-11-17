// Row counts and checksums per table (operations/fingerprint.ts), for restore drills.
//   node --env-file=.env scripts/db-fingerprint.ts [--out FILE] [--table NAME ...]
//   node scripts/db-fingerprint.ts --compare A.json B.json      exit 0 equal, 1 different
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true, strict: true,
  options: { out: { type: "string" }, table: { type: "string", multiple: true }, compare: { type: "boolean" } },
});
if (values.compare) {
  const { compareFingerprints } = await import("@topka/backend/operations/fingerprint");
  if (positionals.length !== 2) { console.error("usage: db-fingerprint.ts --compare A.json B.json"); process.exit(2); }
  const [a, b] = positionals.map((f) => JSON.parse(readFileSync(f, "utf8")));
  const diffs = compareFingerprints(a, b);
  console.log(diffs.length ? `fingerprint: ${diffs.length} table(s) differ\n  ${diffs.join("\n  ")}` : `fingerprint: equal (${Object.keys(a).length} tables)`);
  process.exit(diffs.length ? 1 : 0);
}
const { closeDb, sql } = await import("@topka/backend/db");
const { fingerprint } = await import("@topka/backend/operations/fingerprint");
try {
  const fp = await fingerprint(sql, { tables: values.table });
  const json = JSON.stringify(fp, null, 1);
  if (values.out) writeFileSync(values.out, `${json}\n`);
  else console.log(json);
  const rows = Object.values(fp).reduce((s, t) => s + t.rows, 0);
  console.error(`fingerprint: ${Object.keys(fp).length} tables, ${rows} rows`);
} finally {
  await closeDb();
}
