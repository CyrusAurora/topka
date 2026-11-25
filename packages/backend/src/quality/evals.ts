// The offline quality evals (docs/quality.md): each replays the product's own decision code on a labelled
// set in eval/gold and reports that dimension's numbers. No model is called and no database is needed;
// the recorded model answers (scores, relations) come with each case. Dimensions are never combined.
import { normalizeAnalysis, tierThreshold, type AnalysisRun } from "../editorial/analyze.ts";
import { projectScore } from "../editorial/project-score.ts";
import { resolveGroup, type CandidateView, type GroupResolution, type Relation, type Verdict } from "../events/relate.ts";
import { assignParticipant, ownKey, upstreamKeys, type UpstreamItem } from "../events/independence.ts";
import { assessEvidence, type EvidenceInput } from "../projects/evidence.ts";
import { SELECTION } from "@topka/industry/selection";
import { addOutcome, emptyConfusion, groupBy, precisionRecall, ratio } from "./metrics.ts";

// ── Relevance (相关性) ─────────────────────────────────────────────────────────────────────────

export type Decision = "select" | "reject";

export interface RelevanceCase {
  caseId: string;
  /** site: the site's 精选 (two scores against the tier threshold); project: the daily issue's gate. */
  purpose: "site" | "project";
  material: { title: string; originalTitle?: string | null; sourceName: string };
  sourceFacts: { sourceKind: string; sourceTier?: string };
  samplingContext?: { benchmarkSplit?: string; samplingStratum?: string };
  gold: { decision: Decision | "either" };
  recorded: {
    relevance: "pass" | "block" | "unknown";
    inScope: boolean | null;
    prefilter: { label: "PASS" | "BLOCK" | "UNKNOWN"; inScope: boolean | null } | null;
    siteScores: number[] | null;
    projectScores: number[] | null;
  };
}

/** The site's decision from the recorded model answers, through normalizeAnalysis and the current tier thresholds. */
export function replaySite(c: RelevanceCase): { decision: Decision; score: number | null; relevance: string } {
  const r = c.recorded;
  const label = r.prefilter?.label ?? (r.relevance === "block" ? "BLOCK" : "PASS");
  const values = r.siteScores ?? [];
  const run: AnalysisRun = {
    prefilter: { label, inScope: r.inScope ?? r.prefilter?.inScope ?? true, reason: "", model: "recorded", receiptId: 0, reused: true },
    // Recorded "unknown": stopped at the first score (or without copy); either way never listed.
    low: r.relevance === "unknown" ? { first: values[0] ?? 0, floor: SELECTION.firstScoreFloor } : undefined,
    scores: values.length ? { model: "recorded", threshold: tierThreshold(c.sourceFacts.sourceTier ?? "T2"), values, receiptIds: [], reused: true } : null,
    writing: null,
    structure: null,
  };
  const out = normalizeAnalysis(run);
  return { decision: out.selected ? "select" : "reject", score: out.score, relevance: out.relevance };
}

/** The daily issue's gate (projects/issues.ts): in the industry scope, listed, project score at least the issue floor. */
export function replayProject(c: RelevanceCase): { decision: Decision; score: number | null; relevance: string } {
  const r = c.recorded;
  const score = projectScore(r.projectScores ?? []);
  const ok = r.inScope !== false && r.relevance === "pass" && score !== null && score >= SELECTION.issueFloor;
  return { decision: ok ? "select" : "reject", score, relevance: r.relevance };
}

export function evalRelevance(cases: RelevanceCase[]) {
  const out: Record<string, unknown> = {};
  const selectbench: Record<string, { summary: Record<string, unknown>; cases: unknown[]; mistakes: unknown[] }> = {};
  for (const purpose of ["site", "project"] as const) {
    const rows = cases.filter((c) => c.purpose === purpose).map((c) => ({ c, p: purpose === "site" ? replaySite(c) : replayProject(c) }));
    const confusion = (xs: typeof rows) => {
      const m = emptyConfusion();
      for (const { c, p } of xs) if (c.gold.decision !== "either") addOutcome(m, p.decision === "select", c.gold.decision === "select");
      return precisionRecall(m);
    };
    const bySplit = Object.fromEntries([...groupBy(rows, (x) => x.c.samplingContext?.benchmarkSplit ?? "all")].map(([k, xs]) => [k, confusion(xs)]));
    const byStratum = Object.fromEntries([...groupBy(rows, (x) => x.c.samplingContext?.samplingStratum ?? "none")].map(([k, xs]) => [k, { n: xs.length, ...confusion(xs) }]));
    const all = confusion(rows);
    const mistakes = rows
      .filter(({ c, p }) => c.gold.decision !== "either" && c.gold.decision !== p.decision)
      .map(({ c, p }) => ({ caseId: c.caseId, title: c.material.title, gold: c.gold.decision, predicted: p.decision, score: p.score, relevance: p.relevance }));
    out[purpose] = { cases: rows.length, either: rows.filter((x) => x.c.gold.decision === "either").length, ...all, bySplit, byStratum, mistakes };
    selectbench[`${purpose}-replay`] = {
      summary: { model: `${purpose}-replay`, n: rows.length, decisive: all.tp + all.fp + all.fn + all.tn, either: rows.length - (all.tp + all.fp + all.fn + all.tn), errors: 0, ...all },
      mistakes,
      cases: rows.map(({ c, p }) => ({ caseId: c.caseId, title: c.material.title, stratum: c.samplingContext?.samplingStratum ?? null, gold: c.gold.decision, decision: p.decision, score: p.score, relevance: p.relevance, category: null, reason: null, receiptId: null, error: null })),
    };
  }
  return { metrics: out, selectbench };
}

// ── Dedup / grouping (去重与聚合) ──────────────────────────────────────────────────────────────

export type PairGold = "same" | "related" | "distinct";

export interface GroupingCase {
  caseId: string;
  article: { title: string; at: string | null; source: string };
  candidates: Array<{ factId: number; storyId: number; storyRoot: boolean; title: string; score: number; relation: Relation; confidence: number }>;
  /** The pair model's recorded answers (group_review receipts), by fact id. */
  reviews: Record<string, Relation>;
  recorded: { verdict: GroupResolution["verdict"]; factId: number | null; storyId: number | null };
  pairs: Array<{ factId: number; gold: PairGold }>;
  samplingContext?: { benchmarkSplit?: string };
}

export async function replayGrouping(c: GroupingCase): Promise<GroupResolution> {
  const views: CandidateView[] = c.candidates.map((x) => ({
    factId: x.factId, storyId: x.storyId, factTitle: x.title, members: 1, storyRoot: x.storyRoot, score: x.score,
    report: { title: x.title, source: "", firstParty: false, at: null, summary: null },
  }));
  const verdicts = new Map<number, Verdict>(c.candidates.map((x) => [x.factId, { relation: x.relation, confidence: x.confidence, note: "" }]));
  // A review production did not record (it did not need one then): what production ended up doing.
  const review = async (pick: CandidateView): Promise<Relation> =>
    c.reviews[String(pick.factId)] ?? (c.recorded.verdict === "same-fact" && c.recorded.factId === pick.factId ? "SAME_OCCURRENCE" : "UNRELATED");
  return resolveGroup(views, verdicts, review);
}

/** What a resolution means for one candidate fact: merged into it, joined its story, or kept apart. */
export function pairOutcome(res: GroupResolution, factId: number, storyId: number): PairGold {
  if (res.verdict === "same-fact" && res.factId === factId) return "same";
  if (res.storyId !== null && res.storyId === storyId) return "related";
  return "distinct";
}

export async function evalGrouping(cases: GroupingCase[]) {
  let pairs = 0, correct = 0, notSame = 0, falseMerge = 0, same = 0, missedMerge = 0, faithful = 0;
  const story = emptyConfusion();
  const matrix: Record<string, Record<string, number>> = {};
  const mistakes: unknown[] = [];
  for (const c of cases) {
    const res = await replayGrouping(c);
    // Recorded ids of a new fact or story are the ones production created; only the target is compared.
    const rec = c.recorded;
    if (res.verdict === rec.verdict && (rec.verdict === "same-fact" ? res.factId === rec.factId : rec.verdict === "new-fact-in-story" ? res.storyId === rec.storyId : true)) faithful++;
    for (const p of c.pairs) {
      const cand = c.candidates.find((x) => x.factId === p.factId);
      if (!cand) continue;
      const pred = pairOutcome(res, p.factId, cand.storyId);
      pairs++;
      (matrix[p.gold] ??= {})[pred] = (matrix[p.gold]![pred] ?? 0) + 1;
      if (pred === p.gold) correct++;
      else mistakes.push({ caseId: c.caseId, title: c.article.title, candidate: cand.title, gold: p.gold, predicted: pred });
      if (p.gold === "same") { same++; if (pred !== "same") missedMerge++; } else { notSame++; if (pred === "same") falseMerge++; }
      addOutcome(story, pred !== "distinct", p.gold !== "distinct");
    }
  }
  return {
    cases: cases.length,
    pairs,
    pairAccuracy: ratio(correct, pairs),
    /** 误合并率: merged into a fact the label says is not the same occurrence. */
    falseMergeRate: ratio(falseMerge, notSame),
    /** 漏合并率: kept apart from a fact the label says is the same occurrence. */
    missedMergeRate: ratio(missedMerge, same),
    falseMerges: falseMerge,
    missedMerges: missedMerge,
    storyLevel: precisionRecall(story),
    /** Share of decisions the replay reproduces exactly (checks the replay itself, not the product). */
    replayFidelity: ratio(faithful, cases.length),
    confusion: matrix,
    mistakes,
  };
}

// ── Source independence (来源独立性) ───────────────────────────────────────────────────────────

export interface IndependenceCase {
  caseId: string;
  kind: string;
  items: Array<UpstreamItem & { upstream: string }>;
  gold: { upstreams: number };
  samplingContext?: { benchmarkSplit?: string };
}

/** How the product counts the group's participants: each report in order, merged into a peer only (events/group.ts). */
export function productParticipants(items: UpstreamItem[]): number {
  const at = (i: UpstreamItem) => (i.publishedAt ? new Date(i.publishedAt).getTime() || 0 : 0);
  const sorted = [...items].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
  const existing = new Map<string, string>();
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i]!;
    existing.set(it.id, assignParticipant(sorted.slice(0, i + 1), it.id, existing, ownKey(it)));
  }
  return new Set(existing.values()).size;
}

export function evalIndependence(cases: IndependenceCase[]) {
  let exact = 0, productExact = 0, bySourceExact = 0, absErr = 0, over = 0, under = 0, reports = 0, goldDup = 0, keptDup = 0;
  // 转载组识别: every pair of reports in a group, "same upstream" or not, against the labels.
  const pairs = emptyConfusion();
  const mistakes: unknown[] = [];
  for (const c of cases) {
    const keys = upstreamKeys(c.items);
    const detected = new Set(keys.values()).size;
    const product = productParticipants(c.items);
    const bySource = new Set(c.items.map((i) => ownKey(i))).size;
    for (let x = 0; x < c.items.length; x++) {
      for (let y = 0; y < x; y++) {
        const a = c.items[x]!, b = c.items[y]!;
        addOutcome(pairs, keys.get(a.id) === keys.get(b.id), a.upstream === b.upstream);
      }
    }
    reports += c.items.length;
    goldDup += c.items.length - c.gold.upstreams;
    keptDup += Math.max(0, product - c.gold.upstreams);
    if (detected === c.gold.upstreams) exact++;
    else mistakes.push({ caseId: c.caseId, gold: c.gold.upstreams, detected, items: c.items.map((i) => `${i.sourceName} → ${keys.get(i.id)} (gold ${i.upstream})`) });
    if (product === c.gold.upstreams) productExact++;
    if (bySource === c.gold.upstreams) bySourceExact++;
    absErr += Math.abs(detected - c.gold.upstreams);
    if (detected > c.gold.upstreams) over++;
    if (detected < c.gold.upstreams) under++;
  }
  return {
    groups: cases.length,
    reports,
    /** Share of groups whose independent-upstream count the detector gets exactly. */
    exactCount: ratio(exact, cases.length),
    meanAbsError: ratio(absErr, cases.length),
    overCounted: over,
    underCounted: under,
    /** The same, for the count the product stores (story_signals participants). */
    productExactCount: ratio(productExact, cases.length),
    /** Share of the reports that only repeat an upstream and that the product still counts as independent. */
    productDuplicatesKept: ratio(keptDup, goldDup),
    /** 转载组识别准确率: report pairs put in the same upstream (or not) as the labels say. */
    reprintPairs: precisionRecall(pairs),
    /** Before this detector: one participant per source (or signal group). */
    perSourceExactCount: ratio(bySourceExact, cases.length),
    mistakes,
  };
}

// ── Abstention (弃答) ─────────────────────────────────────────────────────────────────────────

export interface AbstentionCase {
  caseId: string;
  origin: "production" | "constructed";
  split: string;
  variant?: string;
  input: EvidenceInput;
  gold: { sufficient: boolean; reason?: string };
}

export function evalAbstention(cases: AbstentionCase[]) {
  const rate = (xs: AbstentionCase[]) => {
    let insufficient = 0, abstained = 0, sufficient = 0, falseAbstain = 0, reasonMatch = 0;
    for (const c of xs) {
      const v = assessEvidence(c.input);
      if (!c.gold.sufficient) {
        insufficient++;
        if (!v.sufficient) { abstained++; if (!c.gold.reason || v.reason === c.gold.reason) reasonMatch++; }
      } else {
        sufficient++;
        if (!v.sufficient) falseAbstain++;
      }
    }
    return { insufficient, abstained, abstainRate: ratio(abstained, insufficient), reasonMatch: ratio(reasonMatch, abstained), sufficient, falseAbstained: falseAbstain, falseAbstainRate: ratio(falseAbstain, sufficient) };
  };
  const mistakes = cases.flatMap((c) => {
    const v = assessEvidence(c.input);
    return v.sufficient === c.gold.sufficient ? [] : [{ caseId: c.caseId, title: c.input.title, gold: c.gold, got: v }];
  });
  return {
    cases: cases.length,
    ...rate(cases),
    byOrigin: Object.fromEntries([...groupBy(cases, (c) => (c.split === "blind" ? "blind" : c.origin))].map(([k, xs]) => [k, rate(xs)])),
    byVariant: Object.fromEntries([...groupBy(cases.filter((c) => c.variant), (c) => c.variant!)].map(([k, xs]) => [k, rate(xs)])),
    mistakes,
  };
}


// ── SelectBench rows (admin → SelectBench): the per-case results of the grouping and abstention evals ──

export async function groupingBenchRows(cases: GroupingCase[]) {
  const rows: Array<{ caseId: string; title: string; stratum: string | null; gold: string; decision: string; score: number | null; relevance: null; category: null; reason: string | null; receiptId: null; error: null }> = [];
  for (const c of cases) {
    const res = await replayGrouping(c);
    for (const p of c.pairs) {
      const cand = c.candidates.find((x) => x.factId === p.factId);
      if (!cand) continue;
      rows.push({ caseId: `${c.caseId}:${p.factId}`, title: `${c.article.title} ↔ ${cand.title}`, stratum: cand.relation, gold: p.gold, decision: pairOutcome(res, p.factId, cand.storyId), score: cand.score, relevance: null, category: null, reason: `${res.verdict}`, receiptId: null, error: null });
    }
  }
  return rows;
}

export function abstentionBenchRows(cases: AbstentionCase[]) {
  return cases.map((c) => {
    const v = assessEvidence(c.input);
    return { caseId: c.caseId, title: c.input.title, stratum: c.split === "blind" ? "blind" : c.origin, gold: c.gold.sufficient ? "keep" : "abstain", decision: v.sufficient ? "keep" : "abstain", score: null, relevance: null, category: c.gold.reason ?? null, reason: v.sufficient ? null : `${v.reason}: ${v.detail}`, receiptId: null, error: null };
  });
}
