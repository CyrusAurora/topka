// The quality report (docs/quality.md): runs the eight evals on the files in eval/, checks them against
// eval/thresholds.json, and renders docs/quality/report.md + baseline.json. Each dimension keeps its own
// numbers; there is deliberately no combined score anywhere (design: 质量维度分开).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { evalAbstention, evalGrouping, evalIndependence, evalRelevance, type AbstentionCase, type GroupingCase, type IndependenceCase, type RelevanceCase } from "./evals.ts";
import { evalCitationSample, type CitationResult, type CitationSampleCase } from "./citation.ts";
import { coverage, freshness, timeSaved, type RuntimeSnapshot } from "./runtime.ts";

/** The eight dimensions, in the design's order (master-design.md ch. 4). */
export const ITEMS = ["coverage", "relevance", "grouping", "citation", "independence", "freshness", "abstention", "timeSaved"] as const;
export type Item = (typeof ITEMS)[number];

export const TITLES: Record<Item, string> = {
  coverage: "覆盖度 Coverage",
  relevance: "相关性 Relevance",
  grouping: "去重与聚合 Dedup / grouping",
  citation: "引用完整性 Citation completeness",
  independence: "来源独立性 Source independence",
  freshness: "时效性 Freshness",
  abstention: "弃答 Abstention",
  timeSaved: "节省时间 Time saved",
};

/** The design's bar for abstention (证据纪律): at least 90% of insufficient-evidence samples abstained. */
export const ABSTAIN_BAR = 0.9;

export interface Threshold {
  item: Item;
  /** Dot path into that item's metrics, e.g. "project.precision". */
  metric: string;
  min?: number;
  max?: number;
  /** Skipped (not failed) when the number is absent: the split-restore scenario needs a test database. */
  optional?: boolean;
  why: string;
}

export interface CheckResult extends Threshold {
  value: number | null;
  pass: boolean;
}

export interface QualityReport {
  generatedAt: string;
  datasets: Record<string, { file: string; cases: number; sha256: string }>;
  items: Record<Item, Record<string, unknown>>;
  checks: CheckResult[];
}

const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

export function pick(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function check(items: QualityReport["items"], thresholds: Threshold[]): CheckResult[] {
  return thresholds.map((t) => {
    const raw = pick(items[t.item], t.metric);
    const value = typeof raw === "number" ? raw : null;
    const pass = value === null ? Boolean(t.optional) : (t.min === undefined || value >= t.min) && (t.max === undefined || value <= t.max);
    return { ...t, value, pass };
  });
}

/** Runs every offline eval over the files under `root` (the repo): gold sets, the runtime snapshot, the scenario result. */
export async function buildReport(root: string, opts: { now?: Date; splitRestoreFile?: string } = {}): Promise<QualityReport> {
  const gold = (name: string) => path.join(root, "eval/gold", name);
  const files = {
    relevance: gold("gold-relevance.jsonl"),
    grouping: gold("gold-grouping.jsonl"),
    independence: gold("gold-independence.jsonl"),
    abstention: gold("gold-abstention.jsonl"),
    citation: gold("gold-citation.jsonl"),
    runtime: path.join(root, "eval/snapshots/runtime.json"),
  };
  const relevance = readJsonl<RelevanceCase>(files.relevance);
  const grouping = readJsonl<GroupingCase>(files.grouping);
  const independence = readJsonl<IndependenceCase>(files.independence);
  const abstention = readJsonl<AbstentionCase>(files.abstention);
  const citation = readJsonl<CitationSampleCase>(files.citation);
  const snapshot = JSON.parse(readFileSync(files.runtime, "utf8")) as RuntimeSnapshot & { citation: CitationResult; createdAt: string };
  const datasets: QualityReport["datasets"] = {};
  const counts: Record<keyof typeof files, number> = { relevance: relevance.length, grouping: grouping.length, independence: independence.length, abstention: abstention.length, citation: citation.length, runtime: snapshot.articles.length };
  for (const [k, f] of Object.entries(files) as Array<[keyof typeof files, string]>) datasets[k] = { file: path.relative(root, f), cases: counts[k], sha256: sha(f) };

  const splitFile = opts.splitRestoreFile ?? path.join(root, ".data/eval/split-restore.json");
  const splitRestore = existsSync(splitFile) ? (JSON.parse(readFileSync(splitFile, "utf8")) as { splitReports: number; restored: number; paths: unknown[] }) : null;
  const rel = evalRelevance(relevance);
  const abst = evalAbstention(abstention);
  const items: QualityReport["items"] = {
    coverage: { window: { since: snapshot.since, until: snapshot.until }, ...coverage(snapshot) },
    relevance: rel.metrics,
    grouping: {
      ...(await evalGrouping(grouping)),
      // 拆分后误还原数: tests/split-restore.test.ts on a throwaway database; null when it has not run here.
      splitRestored: splitRestore?.restored ?? null,
      splitRestorePaths: splitRestore?.paths ?? null,
    },
    citation: { chain: snapshot.citation, sample: evalCitationSample(citation) },
    independence: evalIndependence(independence),
    freshness: { window: { since: snapshot.since, until: snapshot.until }, ...freshness(snapshot) },
    abstention: { bar: ABSTAIN_BAR, barMet: (abst.abstainRate ?? 0) >= ABSTAIN_BAR, ...abst },
    timeSaved: { window: { since: snapshot.since, until: snapshot.until }, ...timeSaved(snapshot) },
  };
  const thresholds = JSON.parse(readFileSync(path.join(root, "eval/thresholds.json"), "utf8")) as Threshold[];
  return { generatedAt: (opts.now ?? new Date()).toISOString(), datasets, items, checks: check(items, thresholds) };
}

/** Keys that would sum dimensions into one number; the report must never carry one. */
export const COMBINED_KEY = /(overall|composite|total|aggregate)/i;

export function combinedKeys(value: unknown, at = ""): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(COMBINED_KEY.test(k) ? [`${at}${k}`] : []),
    ...combinedKeys(v, `${at}${k}.`),
  ]);
}

const pct = (x: unknown) => (typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "—");
const num = (x: unknown) => (x === null || x === undefined ? "—" : String(x));

/** The Markdown report: one section per dimension, its numbers, and its checks. */
export function renderMarkdown(r: QualityReport): string {
  const it = r.items as Record<Item, any>;
  const lines: string[] = [
    "# Quality report",
    "",
    `Generated by \`npm run eval\` (${r.generatedAt.slice(0, 10)}). How each number is measured: [docs/quality.md](../quality.md).`,
    "Each dimension stands on its own; there is no combined score.",
    "",
    "| Dataset | Cases | sha256 (16) |",
    "| --- | ---: | --- |",
    ...Object.values(r.datasets).map((d) => `| \`${d.file}\` | ${d.cases} | \`${d.sha256}\` |`),
    "",
  ];
  const checks = (item: Item) => {
    const cs = r.checks.filter((c) => c.item === item);
    if (!cs.length) return [];
    return ["", "| Check | Value | Threshold | |", "| --- | ---: | --- | --- |",
      ...cs.map((c) => `| ${c.metric} | ${num(c.value)} | ${c.min !== undefined ? `≥ ${c.min}` : ""}${c.max !== undefined ? `≤ ${c.max}` : ""} | ${c.pass ? "pass" : "**FAIL**"} |`)];
  };
  const section = (item: Item, body: string[]) => lines.push(`## ${TITLES[item]}`, "", ...body, ...checks(item), "");

  const cov = it.coverage;
  section("coverage", [
    `Window ${cov.window.since.slice(0, 10)} → ${cov.window.until.slice(0, 10)} (${cov.days} days), ${cov.enabledSources} enabled sources, ${cov.runs} fetch runs (${cov.failedRuns} failed).`,
    "",
    `- Plan completion (successful runs / runs the intervals ask for): ${pct(cov.planCompletion)}`,
    `- Required sources (bound to an active project): ${cov.requiredSources}; days without a successful run: ${cov.requiredGapDays} (${pct(cov.requiredGapRate)} of source-days)`,
    `- Enabled sources whose last 3 runs all failed: ${cov.failingSources} (${pct(cov.failingRate)})`,
  ]);
  const rl = (k: "site" | "project") => it.relevance[k];
  section("relevance", (["project", "site"] as const).flatMap((k) => [
    `- ${k === "project" ? "Daily issue gate (project)" : "Site selection (精选)"}: ${rl(k).cases} cases (${rl(k).either} "either"); precision ${num(rl(k).precision)}, recall ${num(rl(k).recall)}, accuracy ${num(rl(k).accuracy)} (TP ${rl(k).tp} / FP ${rl(k).fp} / FN ${rl(k).fn} / TN ${rl(k).tn})`,
    ...Object.entries(rl(k).bySplit as Record<string, any>).map(([s, m]) => `  - ${s}: precision ${num(m.precision)}, recall ${num(m.recall)}`),
  ]));
  const g = it.grouping;
  section("grouping", [
    `${g.cases} grouping decisions, ${g.pairs} labelled report–fact pairs (same / related / distinct).`,
    "",
    `- Pair accuracy (3 classes): ${num(g.pairAccuracy)}`,
    `- 误合并率 false merge rate: ${num(g.falseMergeRate)} (${g.falseMerges} pairs)`,
    `- 漏合并率 missed merge rate: ${num(g.missedMergeRate)} (${g.missedMerges} pairs)`,
    `- Story level (same or related story): precision ${num(g.storyLevel.precision)}, recall ${num(g.storyLevel.recall)}`,
    `- 拆分后误还原数 split reports restored: ${num(g.splitRestored)}${g.splitRestorePaths ? ` (over ${g.splitRestorePaths.length} automatic paths)` : " (not run here: needs the test database)"}`,
    `- Replay fidelity (the replay reproduces production's decision): ${num(g.replayFidelity)}`,
  ]);
  const c = it.citation;
  section("citation", [
    `- Chain check over every card shown (${c.chain.cards} cards: issue items and selected publications): complete ${pct(c.chain.completeRate)}${Object.keys(c.chain.problems).length ? `, problems ${JSON.stringify(c.chain.problems)}` : ""}`,
    `- Manual sample (${c.sample.cards} issue cards read against the original): main statement located ${pct(c.sample.located)}; every statement supported ${pct(c.sample.fullySupported)}; partly supported ${c.sample.partlySupported}; unsupported ${c.sample.unsupported}`,
    ...c.sample.unsupportedStatements.map((u: any) => `  - ${u.caseId}: “${u.statement}”`),
  ]);
  const ind = it.independence;
  section("independence", [
    `${ind.groups} groups of real reports (${ind.reports} reports), each report labelled with its upstream.`,
    "",
    `- Detector gets the independent-upstream count exactly: ${pct(ind.exactCount)} (mean absolute error ${num(ind.meanAbsError)})`,
    `- Product count (story_signals participants, merged into a peer only): exact ${pct(ind.productExactCount)}; repeats still counted as independent ${pct(ind.productDuplicatesKept)}`,
    `- Before (one participant per source): exact ${pct(ind.perSourceExactCount)}`,
  ]);
  const f = it.freshness;
  section("freshness", [
    `Discovery lag (discovered − published) of ${f.n} non-backfill articles, ${f.window.since.slice(0, 10)} → ${f.window.until.slice(0, 10)}.`,
    "",
    `- All: P50 ${num(f.p50Minutes)} min, P90 ${num(f.p90Minutes)} min, over 24 h ${pct(f.over24h)}`,
    ...Object.entries(f.byKind as Record<string, any>).map(([k, m]) => `- ${k}: n=${m.n}, P50 ${num(m.p50Minutes)} min, P90 ${num(m.p90Minutes)} min${m.enough ? "" : " (too few)"}`),
  ]);
  const a = it.abstention;
  section("abstention", [
    `${a.cases} cases: ${a.insufficient} with insufficient evidence, ${a.sufficient} with enough.`,
    "",
    `- Abstained on insufficient evidence: ${pct(a.abstainRate)} (${a.abstained}/${a.insufficient}); the bar is ${pct(a.bar)}: **${a.barMet ? "met" : "not met"}**`,
    `- Abstained although evidence was enough (false abstention): ${pct(a.falseAbstainRate)} (${a.falseAbstained}/${a.sufficient})`,
    ...Object.entries(a.byOrigin as Record<string, any>).map(([k, m]) => `  - ${k}: abstained ${m.abstained}/${m.insufficient}, false ${m.falseAbstained}/${m.sufficient}`),
  ]);
  const t = it.timeSaved;
  section("timeSaved", [
    `- Issues: ${t.issues} (${t.items} items); median materials per issue window ${num(t.medianMaterialsPerIssue)}; median share shown ${pct(t.medianUpdateShare)}`,
    `- Reading time per issue (first to last opened item): median ${num(t.medianReadSpanMinutes)} min over ${t.readSpanSamples} issues${t.enough ? "" : " — too few to rely on"}`,
    `- Interviews (time spent before): not measurable from data; see docs/quality.md.`,
  ]);
  return lines.join("\n");
}
