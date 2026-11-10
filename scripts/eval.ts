// The quality evals (docs/quality.md): eight dimensions, each with its own labelled set or snapshot in
// eval/, its own numbers and its own thresholds (eval/thresholds.json). Offline by default: no model,
// no network, no database.
//   npm run eval                      print every dimension and the threshold checks
//   npm run eval -- --check           the same, exit 1 when a check fails (CI)
//   npm run eval -- --write           also write docs/quality/report.md and docs/quality/baseline.json
//   npm run eval -- --import          store each eval's per-case results as SelectBench runs (needs DATABASE_URL)
//   npm run eval -- --live --model <id>:free   re-score the site relevance set with a free model (eval-selection.ts;
//                                     another model id needs --allow-paid)
// The split-restore number comes from tests/split-restore.test.ts (.data/eval/split-restore.json).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@topka/backend/config";
import { buildReport, combinedKeys, renderMarkdown } from "@topka/backend/quality/report";

const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    import: { type: "boolean", default: false },
    live: { type: "boolean", default: false },
    model: { type: "string" },
    "allow-paid": { type: "boolean", default: false },
  },
});

if (values.live) {
  if (!values.model) throw new Error("--live needs --model <id> (a free model; see docs/quality.md)");
  // A live run calls the model once or twice per case: only ":free" model ids unless paying is explicit.
  if (!values.model.endsWith(":free") && !values["allow-paid"]) throw new Error(`--live: ${values.model} is not a ":free" model id; add --allow-paid to spend on it`);
  const r = spawnSync(process.execPath, ["scripts/eval-selection.ts", "--gold", "eval/gold/gold-relevance.jsonl", "--purpose", "site", "--models", values.model, "--no-import"], { cwd: REPO_ROOT, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const report = await buildReport(REPO_ROOT);
const combined = combinedKeys(report);
if (combined.length) throw new Error(`the report must not combine dimensions: ${combined.join(", ")}`);

if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(renderMarkdown(report));
  console.log("");
}
const failed = report.checks.filter((c) => !c.pass);
console.log(`checks: ${report.checks.length - failed.length}/${report.checks.length} pass`);
for (const c of failed) console.log(`  FAIL ${c.item}.${c.metric} = ${c.value} (${c.min !== undefined ? `min ${c.min}` : ""}${c.max !== undefined ? ` max ${c.max}` : ""}) — ${c.why}`);

if (values.write) {
  const dir = path.join(REPO_ROOT, "docs/quality");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "report.md"), renderMarkdown(report) + "\n");
  // The baseline keeps the numbers, not the per-case mistake lists (those are in `--json`).
  const strip = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "mistakes" && k !== "broken").map(([k, x]) => [k, strip(x)])) : v;
  writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(strip(report), null, 2) + "\n");
  console.log("wrote docs/quality/report.md, docs/quality/baseline.json");
}

if (values.import) {
  // Each eval's per-case results go to admin → SelectBench, one run per dimension (design ch. 4: 错例进后台).
  const { evalRelevance, groupingBenchRows, abstentionBenchRows } = await import("@topka/backend/quality/evals");
  const { importSelectBenchRun } = await import("@topka/backend/admin/selectbench");
  const { closeDb } = await import("@topka/backend/db");
  const { readFileSync } = await import("node:fs");
  const load = (f: string) => readFileSync(path.join(REPO_ROOT, "eval/gold", f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const at = new Date().toISOString();
  const rel = load("gold-relevance.jsonl");
  const runs: Array<[string, unknown]> = [
    [`相关性 · 生产记录重放 · ${rel.length} 条`, { meta: { split: "all", n: rel.length, promptVersion: "recorded scores (replay)", createdAt: at }, models: evalRelevance(rel).selectbench }],
  ];
  const grp = load("gold-grouping.jsonl");
  const grpRows = await groupingBenchRows(grp);
  const g = report.items.grouping as Record<string, unknown>;
  runs.push([`去重 · 生产记录重放 · ${grpRows.length} 对`, { meta: { split: "all", n: grpRows.length, promptVersion: "recorded relations (replay)", createdAt: at }, models: { "grouping-replay": { summary: { model: "grouping-replay", n: grpRows.length, accuracy: g.pairAccuracy, falseMergeRate: g.falseMergeRate, missedMergeRate: g.missedMergeRate }, cases: grpRows } } }]);
  const abs = load("gold-abstention.jsonl");
  const a = report.items.abstention as Record<string, unknown>;
  runs.push([`弃答 · 证据规则 · ${abs.length} 条`, { meta: { split: "all", n: abs.length, promptVersion: "projects/evidence.ts", createdAt: at }, models: { "evidence-rules": { summary: { model: "evidence-rules", n: abs.length, abstainRate: a.abstainRate, falseAbstainRate: a.falseAbstainRate }, cases: abstentionBenchRows(abs) } } }]);
  for (const [label, run] of runs) console.log(`SelectBench run: ${(await importSelectBenchRun(run, label, "script:eval")).id} (${label})`);
  await closeDb();
}

if (values.check && failed.length) process.exit(1);
