// The quality evals (docs/quality.md): the eight dimensions run offline on the files in eval/, every
// threshold in eval/thresholds.json holds, the abstention bar is met, and nothing anywhere combines the
// dimensions into one score. The metric functions are checked on small hand-made inputs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REPO_ROOT } from "@topka/backend/config";
import { ITEMS, buildReport, check, combinedKeys, pick, renderMarkdown } from "@topka/backend/quality/report";
import { median, percentile, precisionRecall, ratio } from "@topka/backend/quality/metrics";
import { coverage, freshness, timeSaved, type RuntimeSnapshot } from "@topka/backend/quality/runtime";
import { pairOutcome, replayProject, replaySite, type RelevanceCase } from "@topka/backend/quality/evals";
import { evalCitationSample } from "@topka/backend/quality/citation";

test("the report over the committed datasets: eight dimensions, every check passes, no combined score", async () => {
  const r = await buildReport(REPO_ROOT, { splitRestoreFile: "/nonexistent" });
  assert.deepEqual(Object.keys(r.items), [...ITEMS]);
  assert.deepEqual(r.checks.filter((c) => !c.pass).map((c) => `${c.item}.${c.metric}=${c.value}`), []);
  assert.deepEqual(combinedKeys(r), []);
  assert.equal(pick(r.items.abstention, "barMet"), true);
  // The scenario number is absent here (no test database in this check): reported as not run.
  assert.equal(pick(r.items.grouping, "splitRestored"), null);
  const md = renderMarkdown(r);
  for (const heading of ["覆盖度", "相关性", "去重与聚合", "引用完整性", "来源独立性", "时效性", "弃答", "节省时间"]) assert.match(md, new RegExp(`## ${heading}`));
  assert.doesNotMatch(md, /总分|综合分|overall score|composite/i);
});

test("combined keys are caught wherever they hide", () => {
  assert.deepEqual(combinedKeys({ a: { overallScore: 1 }, total: 2, fine: [1] }), ["a.overallScore", "total"]);
});

test("threshold checks: min, max, absent values and optional ones", () => {
  const items = { relevance: { site: { precision: 0.5 } }, grouping: { splitRestored: null } } as never;
  const res = check(items, [
    { item: "relevance", metric: "site.precision", min: 0.6, why: "" },
    { item: "relevance", metric: "site.precision", max: 0.6, why: "" },
    { item: "relevance", metric: "site.recall", min: 0, why: "" },
    { item: "grouping", metric: "splitRestored", max: 0, optional: true, why: "" },
  ]);
  assert.deepEqual(res.map((c) => c.pass), [false, true, false, true]);
});

test("metric helpers", () => {
  assert.equal(ratio(1, 3), 0.333);
  assert.equal(ratio(1, 0), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 90), 5);
  assert.equal(percentile([], 50), null);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(precisionRecall({ tp: 1, fp: 1, fn: 0, tn: 2 }), { tp: 1, fp: 1, fn: 0, tn: 2, precision: 0.5, recall: 1, accuracy: 0.75 });
});

test("relevance replay follows the product's rules", () => {
  const c = (recorded: Partial<RelevanceCase["recorded"]>, tier = "T1"): RelevanceCase => ({
    caseId: "x", purpose: "site", material: { title: "t", sourceName: "s" }, sourceFacts: { sourceKind: "rss", sourceTier: tier }, gold: { decision: "select" },
    recorded: { relevance: "pass", inScope: true, prefilter: { label: "PASS", inScope: true }, siteScores: [70, 70], projectScores: [60, 61], ...recorded },
  });
  assert.equal(replaySite(c({})).decision, "select");
  assert.equal(replaySite(c({ siteScores: [50, 50] })).decision, "reject");
  assert.equal(replaySite(c({ relevance: "block", prefilter: { label: "BLOCK", inScope: true } })).decision, "reject");
  assert.equal(replaySite(c({ inScope: false })).decision, "reject");
  assert.equal(replaySite(c({ relevance: "unknown", siteScores: [20] })).decision, "reject");
  assert.equal(replayProject(c({})).decision, "select");
  assert.equal(replayProject(c({ projectScores: [40, 45] })).decision, "reject");
  assert.equal(replayProject(c({ projectScores: null })).decision, "reject");
  assert.equal(pairOutcome({ verdict: "same-fact", factId: 1, storyId: 9 }, 1, 9), "same");
  assert.equal(pairOutcome({ verdict: "same-fact", factId: 1, storyId: 9 }, 2, 9), "related");
  assert.equal(pairOutcome({ verdict: "new-story", factId: null, storyId: null }, 2, 9), "distinct");
});

test("runtime metrics on a small snapshot", () => {
  const since = "2026-11-01T00:00:00Z", until = "2026-11-03T00:00:00Z";
  const t0 = Date.parse(since) / 1000;
  const s: RuntimeSnapshot = {
    since, until,
    sources: [
      { kind: "rss", enabled: true, health: "ok", interval: 1440, required: true },
      { kind: "rss", enabled: true, health: "failing", interval: 1440, required: false },
      { kind: "rss", enabled: false, health: "unknown", interval: 60, required: false },
    ],
    runs: [[0, t0 + 100, 1], [0, t0 + 200, 1], [1, t0 + 300, 0], [1, t0 + 400, 0], [1, t0 + 90_000, 0], [2, t0 + 500, -1]],
    articles: [["news", t0, t0 + 600, 0], ["news", t0, t0 + 6000, 0], ["paper", t0, t0 + 60, 0], ["news", null, t0, 0], ["news", t0, t0 + 99_999, 1]],
    issues: [{ user: "u1", date: "2026-11-02", no: 1, fixedAt: t0 + 86_400 }],
    items: [{ user: "u1", date: "2026-11-02", position: 1, article: "a1" }, { user: "u1", date: "2026-11-02", position: 2, article: "a2" }],
    reads: [{ user: "u1", article: "a1", at: t0 + 90_000 }, { user: "u1", article: "a2", at: t0 + 90_120 }],
    marks: [],
    materials: [{ user: "u1", date: "2026-11-02", n: 20 }],
  };
  const f = freshness(s);
  assert.equal(f.n, 3);
  assert.equal(f.skipped, 2);
  assert.equal(f.byKind.news!.p50Minutes, 10);
  const c = coverage(s);
  assert.equal(c.enabledSources, 2);
  assert.equal(c.planCompletion, 0.5, "two of the four planned daily runs succeeded (one source never did)");
  assert.equal(c.requiredGapDays, 1, "the required source had no successful run on day 2");
  assert.equal(c.failingSources, 1);
  const t = timeSaved(s);
  assert.equal(t.medianUpdateShare, 0.1);
  assert.equal(t.medianReadSpanMinutes, 2);
  assert.equal(t.enough, false);
});

test("citation sample: located, supported and the unsupported statements", () => {
  const r = evalCitationSample([
    { caseId: "c1", card: { title: "", core: "", summary: "" }, gold: { chain: "complete", support: "supported", unsupported: [], evidenceSpan: "quote" } },
    { caseId: "c2", card: { title: "", core: "", summary: "" }, gold: { chain: "complete", support: "partial", unsupported: ["extra claim"], evidenceSpan: "quote" } },
  ]);
  assert.equal(r.located, 1);
  assert.equal(r.fullySupported, 0.5);
  assert.deepEqual(r.unsupportedStatements, [{ caseId: "c2", statement: "extra claim" }]);
});
