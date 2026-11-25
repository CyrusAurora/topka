// analyzeArticle: the judging and writing steps, each with its own prompt from the industry pack
// (industry/prompts/). A scored item gets its first score before anything else: below the floor
// (SELECTION.firstScoreFloor) it stops there, one call in all (no copy, no list, state skipped); far
// from the threshold the second score is left out (SELECTION.secondScoreBand). Then:
//   1. prefilter: does the material belong to this industry at all (wide recall). Only BLOCK stops an
//      item; UNKNOWN goes on like PASS (a BLOCK given while material is missing counts as UNKNOWN);
//   2. score: two independent scores against the source tier's threshold (industry/selection.ts) decide 精选;
//   3. writing: the Chinese title, summary and reason by the content understanding for selected and
//      near-selected items, by the cheaper title/summary prompts for the rest;
//   4. structure (no reader-facing text): category, tags, subject companies and the fact frame the
//      topics and the event grouping need; it runs beside the scoring.
// Material with only a title or a feed summary has its article page fetched before it is judged.
import { z } from "zod";
import { CATEGORY_KEYS } from "@topka/contracts/taxonomy";
import { CATEGORIES } from "@topka/industry/taxonomy";
import { SELECTION } from "@topka/industry/selection";
import { sql } from "../db.ts";
import { chatJson, MODELS, type ContentPart } from "../providers/llm.ts";
import { completeReceipt, ProviderRejectedError } from "../providers/receipts.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { modelFor } from "./models.ts";
import { buildMaterial, firstImagePart, loadAnalyzeInput, type AnalyzeInputArticle } from "./input.ts";
import { pageFetchable } from "../content/extract.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import {
  buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt, finalizeCopy, isShortTweetInput, looksZh, MAX_BODY_CHARS, missingEvidence,
  needsShortTweetTranslation, parseTranslateOutput, PREFILTER_SYSTEM, prefilterUser, translateInputOf, UNDERSTAND_SYSTEM, understandUser,
  type IdentityGuard,
} from "./writing.ts";
import { CATEGORY_BY_ITEM_TYPE, CATEGORY_GUIDE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, normalizeTags, TOPIC_TAGS } from "./vocabulary.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { prefilterProjectsSystem, projectScoreSchema, projectScoreSystem, projectsForArticle, storeProjectScores, PREFILTER_PROJECTS_VERSION, PROJECT_SCORE_VERSION, type ProjectBrief, type ProjectScoreRun } from "./project-score.ts";

export { buildMaterial, loadAnalyzeInput, type AnalyzeInputArticle };

export const PROMPT_VERSIONS = {
  prefilter: promptVersion("prefilter"),
  score: promptVersion("selection-score"),
  projectScore: PROJECT_SCORE_VERSION,
  understand: promptVersion("understand"),
  summarize: promptVersion("summarize-article", "summarize-article-empty", "summarize-short-post", "summarize-short-post-quoted", "summarize-long-post", "summarize-long-post-quoted", "identity-context"),
  structure: promptVersion("structure"),
} as const;
/** Every step's prompt, as stored on each judgement. */
export const ANALYZE_PROMPT_VERSION = Object.values(PROMPT_VERSIONS).join("+");

// ── Scoring ───────────────────────────────────────────────────────────────────────────────

/** Independent score calls per article; their sum decides, their mean (floored) is shown. */
export const SCORE_CALLS = 2;

/**
 * The thresholds on the mean score, per source tier (industry/selection.ts): selected when
 * score1 + score2 >= 2 × threshold. Tiers without a threshold are not scored for 精选.
 */
export function tierThreshold(tier: string): number | null {
  return SELECTION.thresholds[tier] ?? null;
}

/**
 * The first score decides how far an item goes (industry/selection.ts): below the floor it stops; the
 * second score only where it could change the outcome (near the tier threshold) or for a project's
 * sources, whose 今日 ranks by the mean of both.
 */
export function firstScoreFloor(projects: number): number {
  return projects > 0 ? SELECTION.projectFirstScoreFloor : SELECTION.firstScoreFloor;
}
export function wantsSecondScore(first: number, threshold: number | null, projects: number): boolean {
  if (projects > 0) return true;
  return threshold !== null && Math.abs(first - threshold) < SELECTION.secondScoreBand;
}

/** The decisive total: the sum of both scores, or twice the only one (null when unscored). */
export function scoreSum(values: number[] | null | undefined): number | null {
  if (!values?.length || values.length > SCORE_CALLS) return null;
  return values.length === SCORE_CALLS ? values.reduce((total, v) => total + v, 0) : values[0]! * SCORE_CALLS;
}

/** Unselected items above this mean are written like selected ones. */
export const UNDERSTAND_FLOOR = SELECTION.understandFloor;

/**
 * Call parameters per score model. The GLM scorer runs at temperature 1 with high reasoning (the model
 * registry adds top_p and thinking) and up to 180 s per call.
 */
const SCORE_CALL: Record<string, { temperature: number; maxTokens: number; timeoutMs: number }> = {
  "glm-5.3-flash-selection": { temperature: 1, maxTokens: 65_536, timeoutMs: 180_000 },
};
const scoreCall = (model: string) => SCORE_CALL[model] ?? { temperature: 0.2, maxTokens: 1024, timeoutMs: 120_000 };

/** The score prompt: the industry's taste (industry/prompts/selection-score.md). */
export const SCORE_SYSTEM = promptText("selection-score");

export const ScoreSchema = z.object({ attentionScore: z.coerce.number().int().min(0).max(100) });

const SCORE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** The score input's time: Beijing time, ISO 8601 with +08:00 (the form the prompt was tuned on). */
export function scoreInputTime(at: Date): string {
  const ms = at.getTime() % 1000;
  return `${SCORE_TIME.format(at).replace(" ", "T")}${ms ? `.${String(ms).padStart(3, "0")}` : ""}+08:00`;
}

/**
 * The score input: no source facts (the prompt forbids guessing them), the publication time, the
 * original title (items are scored before any Chinese copy exists) and the whole body.
 */
export function buildScoreInput(a: AnalyzeInputArticle, ask = "请按系统规则评估以下单篇材料所代表的事件。只输出 attentionScore。"): string {
  let body: string;
  if (a.xPost) {
    const quoted = a.xPost.quoted?.text ? `\n\n[引用 ${a.xPost.quoted.handle ? `@${a.xPost.quoted.handle}` : "原推文"}]：${a.xPost.quoted.text}` : "";
    body = `${String(a.xPost.text ?? "").trim()}${quoted}`.trim();
  } else {
    body = (a.bodyText ?? a.excerpt ?? "").trim();
  }
  if (!body) body = a.title;
  const at = a.publishedAt ?? a.discoveredAt ?? null;
  return [
    ask,
    `【发布时间（北京时间）】\n${at ? scoreInputTime(at) : ""}`,
    `【标题】\n${a.title.trim()}`,
    `【完整正文】\n${body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body}`,
  ].join("\n\n");
}

// ── Step outputs ──────────────────────────────────────────────────────────────────────────

const PrefilterSchema = z.object({
  label: z.preprocess((v) => String(v ?? "").trim().toUpperCase(), z.enum(["PASS", "BLOCK", "UNKNOWN"])),
  /** Only the project-aware prefilter asks it: does the material pass the industry rule on its own? */
  inScope: z.preprocess((v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined), z.boolean().optional()).catch(undefined),
  reason: z.string().max(200).catch(""),
});

const FactSchema = z
  .object({
    title: z.string().max(80),
    subject: z.string().max(80).nullable().optional(),
    action: z.string().max(80).nullable().optional(),
    object: z.string().max(160).nullable().optional(),
    occurredAt: z.string().nullable().optional(),
  })
  .nullable()
  .catch(null);

const StructureSchema = z.object({
  category: z.enum(CATEGORY_KEYS).nullable().catch(null),
  tags: z.array(z.string()).max(12).catch([]),
  subjects: z.array(z.string()).max(6).catch([]),
  fact: FactSchema,
});

const UnderstandSchema = z.object({
  itemType: z.enum(ITEM_TYPES),
  authorRole: z.enum(["principal", "observer", "relayer"]).catch("relayer"),
  tags: z.array(z.string()).max(12).catch([]),
  editorialJudgment: z.string().max(400).catch(""),
  titleZh: z.string().trim().min(1).max(200),
  summaryZh: z.string().trim().min(1).max(4000),
});

const SummarizeSchema = z.object({ titleZh: z.string(), summaryZh: z.string(), bodyZh: z.string() });

const ZH_COUNT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

/** The structure step's prompt (it writes nothing a reader sees), filled from the pack's vocabulary. */
const STRUCTURE_SYSTEM = promptText("structure", {
  categoryCount: ZH_COUNT[CATEGORIES.length] ?? String(CATEGORIES.length),
  categoryGuide: CATEGORY_GUIDE,
  categoryTags: CATEGORY_TAGS.join("、"),
  topicTags: TOPIC_TAGS.join("、"),
  entityTags: ENTITY_TAGS.join("、"),
  entities: Object.entries(ENTITIES).map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`).join("，"),
});

export interface AnalysisRun {
  /**
   * inScope: the material passes the industry rule itself (prompts/prefilter.md), not only a following
   * project's intent; only in-scope items may be selected or enter the daily issue.
   */
  /** null: the first score was below the floor and the item went no further (`low`). */
  prefilter: { label: "PASS" | "BLOCK" | "UNKNOWN"; inScope: boolean; reason: string; model: string; receiptId: number; reused: boolean } | null;
  /** The first score is under the floor: nothing else ran. */
  low?: { first: number; floor: number };
  /**
   * The independent score calls and the tier threshold they are held against; absent when the material
   * is not scored. `refused`: the model's content filter declined it, so it is not selected.
   */
  scores: {
    model: string; threshold: number | null; values: number[]; receiptIds: number[]; reused: boolean; refused?: boolean;
    /**
     * Project-aware scoring (project-score.ts): the article's source is followed by these projects and the
     * same calls scored each of them; `values` is then, per call, the best project's score.
     */
    projects?: ProjectScoreRun[];
  } | null;
  /** The reader-facing copy: `understand` (selected, near-selected), `summarize`, `verbatim` (a Chinese short post), `none`. */
  writing: {
    kind: "understand" | "summarize" | "verbatim" | "none";
    model: string | null;
    titleZh: string;
    summaryZh: string;
    reasonZh: string | null;
    tags: string[] | null;
    itemType?: string;
    authorRole?: string;
    identityGuard?: IdentityGuard;
    receiptIds: number[];
    reused: boolean;
  } | null;
  structure: { model: string; category: string | null; tags: string[]; subjects: string[]; fact: z.infer<typeof FactSchema>; receiptId: number; reused: boolean } | null;
}

const isContentFilter = (error: unknown) => error instanceof ProviderRejectedError && !error.retryable && /contentFilter|"1301"/.test(error.message);

/** Only a title or a feed summary, and a page to fetch: the article is judged on the page. */
export function waitsForPage(a: AnalyzeInputArticle): boolean {
  return a.bodyStatus === "pending" && !a.bodyText && !a.xPost && pageFetchable(a.url, a.source.kind);
}

type StepOpts = { attemptTag?: string; scoreModel?: string; projects?: ProjectBrief[] };
export class AnalysisInterruptedError extends Error {}

function checkAnalysisRunning() {
  if (shutdownSignal.signal.aborted) throw new AnalysisInterruptedError("worker shutting down between analysis stages");
}

const subjectOf = (a: AnalyzeInputArticle) => `article:${a.id}@${a.revision}`;
const tagged = (attemptTag: string | undefined, step: string) => [attemptTag, step].filter(Boolean).join(":") || undefined;

async function runPrefilter(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["prefilter"]>> {
  const model = await modelFor("prefilter");
  const projects = opts.projects ?? [];
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "prefilter_article",
    subject: subjectOf(a),
    // Followed by tracking projects: what they follow passes too, not only AI.
    promptVersion: projects.length ? PREFILTER_PROJECTS_VERSION : PROMPT_VERSIONS.prefilter,
    system: projects.length ? prefilterProjectsSystem(projects) : PREFILTER_SYSTEM,
    user: prefilterUser(a),
    schema: PrefilterSchema,
    temperature: 0,
    // The project-aware prompt is longer and asks for inScope too: free reasoning fallbacks (flint) ran
    // out of room at 512 before writing the JSON.
    maxTokens: projects.length ? 1024 : 512,
    attemptTag: opts.attemptTag,
  });
  // A BLOCK without material to back it counts as UNKNOWN (which goes on).
  const label = res.data.label === "BLOCK" && missingEvidence(a) ? "UNKNOWN" : res.data.label;
  // The industry rule alone: whatever passes it is in scope. With projects the model says so itself;
  // when it leaves the field out, only a source that is all on-topic counts (config.scope "mixed": not).
  const inScope = projects.length ? res.data.inScope ?? a.source.scope !== "mixed" : true;
  return { label, inScope, reason: res.data.reason, model: res.model, receiptId: res.receiptId, reused: res.reused };
}

/** `more(first)`: whether the second call is worth making once the first score is in (default: always). */
async function runScores(a: AnalyzeInputArticle, threshold: number | null, opts: StepOpts, more: (first: number) => boolean = () => true): Promise<NonNullable<AnalysisRun["scores"]>> {
  const model = opts.scoreModel ?? (await modelFor("score"));
  const call = scoreCall(model);
  const projects = opts.projects ?? [];
  const system = projects.length ? projectScoreSystem(projects) : SCORE_SYSTEM;
  const input = projects.length ? buildScoreInput(a, "请按系统规则，分别评估以下单篇材料所代表的事件对每个项目目标的重要性。只输出 projectScores。") : buildScoreInput(a);
  const schema = projects.length ? projectScoreSchema(projects.length) : ScoreSchema.transform((d) => [d.attentionScore]);
  const values: number[] = [];
  const perProject: number[][] = projects.map(() => []);
  const receiptIds: number[] = [];
  let reused = true;
  const runs = () => (projects.length ? projects.map((project, i) => ({ project, values: perProject[i]! })) : undefined);
  // One after the other: the second call reuses the provider's cached prompt.
  for (let i = 0; i < SCORE_CALLS; i++) {
    if (i > 0 && !more(values[0]!)) break;
    checkAnalysisRunning();
    try {
      const res = await chatJson({
        model, purpose: projects.length ? "project_score_article" : "score_article", subject: subjectOf(a),
        promptVersion: projects.length ? PROMPT_VERSIONS.projectScore : PROMPT_VERSIONS.score, system, user: input,
        schema, temperature: call.temperature, maxTokens: call.maxTokens, timeoutMs: call.timeoutMs,
        // Each call is its own paid request; an explicit re-evaluation gets new ones.
        attemptTag: tagged(opts.attemptTag, `score-${i + 1}`),
      });
      res.data.forEach((v, j) => perProject[j]?.push(v));
      values.push(Math.max(...res.data));
      receiptIds.push(res.receiptId);
      reused &&= res.reused;
    } catch (error) {
      // The model's content filter declines the material (Zhipu 1301): not scored, so not selected.
      if (isContentFilter(error)) return { model, threshold, values, receiptIds, reused: false, refused: true, projects: runs()?.map((r) => ({ ...r, values: [] })) };
      throw error;
    }
  }
  return { model, threshold, values, receiptIds, reused, projects: runs() };
}

/**
 * Re-scores an analysed article against the projects that follow its source, without touching its
 * analysis (scripts/project-rescore.ts). Same calls and receipts as the analysis' score step, so an
 * article analysed after this change costs nothing here.
 */
export async function scoreForProjects(articleId: string, opts: { attemptTag?: string } = {}): Promise<ProjectScoreRun[] | null> {
  const a = await loadAnalyzeInput(articleId);
  if (!a?.source.id) return null;
  const projects = await projectsForArticle(articleId);
  if (!projects.length) return [];
  const scores = await runScores(a, null, { ...opts, projects });
  if (scores.refused || !scores.projects) return [];
  await sql.begin(async (tx) => {
    await storeProjectScores(tx, { id: a.id, sourceId: a.source.id!, revision: a.revision }, scores.projects!, { model: scores.model, receiptIds: scores.receiptIds });
    for (const id of scores.receiptIds) await completeReceipt(tx, id);
  });
  return scores.projects;
}

async function runStructure(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["structure"]>> {
  const model = await modelFor("structure");
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "structure_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.structure,
    system: STRUCTURE_SYSTEM,
    user: buildMaterial(a),
    schema: StructureSchema,
    temperature: 0.2,
    maxTokens: 800,
    attemptTag: tagged(opts.attemptTag, "structure"),
  });
  const subjects = [...new Set(res.data.subjects.map((s) => s.trim().toLowerCase()).filter((s) => s in ENTITIES))];
  return { model: res.model, category: res.data.category, tags: normalizeTags(res.data.tags), subjects, fact: res.data.fact, receiptId: res.receiptId, reused: res.reused };
}

/** The content understanding; null when the model's content filter declines the material. */
async function runUnderstand(a: AnalyzeInputArticle, opts: StepOpts): Promise<AnalysisRun["writing"]> {
  const model = await modelFor("understand");
  const text = understandUser(a);
  const call = (image: ContentPart | null) => {
    checkAnalysisRunning();
    return chatJson({
      model, purpose: "understand_article", subject: subjectOf(a), promptVersion: PROMPT_VERSIONS.understand, system: UNDERSTAND_SYSTEM,
      user: image ? [{ type: "text", text }, image] : text, schema: UnderstandSchema, temperature: 0.2, maxTokens: 16_384,
      timeoutMs: 180_000, attemptTag: tagged(opts.attemptTag, "understand"),
    });
  };
  // A model that is known not to read images gets the text only.
  const image = MODELS[model]?.vision === false ? null : await firstImagePart(a);
  let res: Awaited<ReturnType<typeof call>>;
  try {
    res = await call(image);
  } catch (error) {
    if (isContentFilter(error)) return null;
    // The model refused the image (download, format): the text is written without it.
    if (!image || !(error instanceof ProviderRejectedError) || error.retryable) throw error;
    try {
      res = await call(null);
    } catch (retryError) {
      if (isContentFilter(retryError)) return null;
      throw retryError;
    }
  }
  const d = res.data;
  const copy = finalizeCopy(translateInputOf(a), { titleZh: d.titleZh, summaryZh: d.summaryZh });
  return {
    kind: "understand", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: d.editorialJudgment.trim() || null,
    tags: normalizeTags(d.tags, { fallbackCategory: CATEGORY_BY_ITEM_TYPE[d.itemType] }), itemType: d.itemType, authorRole: d.authorRole,
    identityGuard: copy.identityGuard, receiptIds: [res.receiptId], reused: res.reused,
  };
}

/** The title/summary prompts (articles, long and short posts). */
async function runSummarize(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["writing"]>> {
  const t = translateInputOf(a);
  const isX = t.sourceKind === "x_search";
  const short = isShortTweetInput(t);
  const main = collapseWhitespace(t.mainText || t.title);
  const plain = { reasonZh: null, tags: null, receiptIds: [] as number[], reused: true };
  // A short post already in Chinese is its own copy, and too little text is not written up from a title.
  if (short && !needsShortTweetTranslation(main)) return { kind: "verbatim", model: null, titleZh: main, summaryZh: main, ...plain };
  if (!short && t.text.trim().length < 20) return { kind: "none", model: null, titleZh: looksZh(t.title) ? t.title : "", summaryZh: "", ...plain };
  const model = await modelFor("summarize");
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "summarize_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.summarize,
    system: "",
    user: short ? buildShortTweetPrompt(t) : isX ? buildLongTweetPrompt(t) : buildArticlePrompt(t),
    schema: SummarizeSchema,
    json: false,
    parse: parseTranslateOutput,
    temperature: 0.2,
    maxTokens: 2048,
    attemptTag: tagged(opts.attemptTag, "summarize"),
  });
  const p = res.data;
  const draft = short
    ? { titleZh: p.titleZh || (looksZh(main) ? main : ""), summaryZh: p.bodyZh || p.summaryZh }
    : isX
      ? { titleZh: p.titleZh, summaryZh: p.summaryZh || p.bodyZh }
      : { titleZh: p.titleZh || (looksZh(t.title) ? t.title : ""), summaryZh: p.summaryZh };
  const copy = finalizeCopy(t, draft);
  return { kind: "summarize", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: null, tags: null, identityGuard: copy.identityGuard, receiptIds: [res.receiptId], reused: res.reused };
}

/**
 * Runs the steps on the material as it is (or reuses their receipts) without writing business results.
 * `stages: "selection"` stops after the scores (SelectBench).
 */
export async function runAnalysis(a: AnalyzeInputArticle, opts: StepOpts & { stages?: "selection" | "all" } = {}): Promise<AnalysisRun> {
  checkAnalysisRunning();
  // SelectBench measures the generic taste: no project, the prefilter and both scores as before.
  const selection = opts.stages === "selection";
  // Followed by tracking projects: their intent widens the prefilter and replaces the generic reader in
  // the same score calls (also for a tier that has no 精选 threshold: the project's today view
  // orders by this score).
  const projects = selection ? [] : (opts.projects ?? (a.source.id ? await projectsForArticle(a.id) : []));
  const scoreOpts = { ...opts, projects };
  const threshold = tierThreshold(a.source.tier);
  if (selection) {
    const prefilter = await runPrefilter(a, scoreOpts);
    if (prefilter.label === "BLOCK") return { prefilter, scores: null, writing: null, structure: null };
    const scores = threshold === null ? null : await runScores(a, threshold, scoreOpts);
    return { prefilter, scores, writing: null, structure: null };
  }
  const scored = threshold !== null || projects.length > 0;
  // Scored items: the first score before anything else. Below the floor the item stops (one call);
  // the second score only where it can still change the outcome.
  const floor = firstScoreFloor(projects.length);
  const scores = scored ? await runScores(a, threshold, scoreOpts, (first) => first >= floor && wantsSecondScore(first, threshold, projects.length)) : null;
  const low = !!scores && !scores.refused && scores.values.length > 0 && scores.values[0]! < floor;
  if (low) return { prefilter: null, low: { first: scores!.values[0]!, floor }, scores, writing: null, structure: null };
  const prefilter = await runPrefilter(a, scoreOpts);
  // UNKNOWN is let through (its material is as complete as it will get); BLOCK stops here.
  if (prefilter.label === "BLOCK") return { prefilter, scores, writing: null, structure: null };
  // The structure step needs nothing from the writing: it runs beside it.
  const structure = runStructure(a, opts).then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    const sum = scores && !scores.refused ? scoreSum(scores.values) : null;
    const near = sum !== null && ((scores!.threshold !== null && sum >= scores!.threshold * SCORE_CALLS) || sum > UNDERSTAND_FLOOR * SCORE_CALLS);
    const writing = (near ? await runUnderstand(a, opts) : null) ?? (await runSummarize(a, opts));
    const s = await structure;
    if ("error" in s) throw s.error;
    return { prefilter, scores, writing, structure: s.value };
  } finally {
    // A writing error or deploy must not let the job finish while a paid structure request
    // still owns a response. It settles and stores its receipt before shutdown can close the DB.
    await structure;
  }
}

/** One judgement from the steps: the selection rule, the reader-facing copy and the structure. */
export function normalizeAnalysis(run: AnalysisRun) {
  const label = run.prefilter?.label ?? null;
  const titleZh = collapseWhitespace(run.writing?.titleZh ?? "");
  const summaryZh = (run.writing?.summaryZh ?? "").trim();
  // Past the prefilter (PASS or UNKNOWN) an item is relevant, but without a usable Chinese title and
  // summary it cannot be published: it waits.
  // Stopped at the first score: no copy, so it is never listed ("unknown").
  const relevance = label === "BLOCK" ? "block" : run.low || (run.writing && (!titleZh || !summaryZh)) ? "unknown" : "pass";
  // Selected when the scores add up to twice the tier threshold (one score far from it counts twice);
  // the mean, floored, is the score shown (it never decides a half point on its own).
  const values = run.scores && !run.scores.refused ? run.scores.values : null;
  const sum = scoreSum(values);
  const score = sum === null ? null : Math.floor(sum / SCORE_CALLS);
  const threshold = run.scores?.threshold ?? null;
  // Out of the industry's scope (passed for a project only): the project's views, never the selection.
  const inScope = run.prefilter?.inScope ?? true;
  const selected = inScope && relevance === "pass" && sum !== null && threshold !== null && sum >= threshold * SCORE_CALLS;
  const subjects = run.structure?.subjects ?? [];
  const tags = [...(run.writing?.tags ?? run.structure?.tags ?? [])];
  for (const s of subjects) {
    const display = ENTITIES[s]?.displayTag;
    if (display && !tags.includes(display)) tags.push(display);
  }
  return {
    relevance,
    inScope,
    selected,
    score,
    scores: values,
    scoreModel: run.scores?.model ?? null,
    scoreRefused: run.scores?.refused ?? false,
    threshold,
    category: run.structure?.category ?? null,
    tags,
    subjects,
    titleZh,
    summaryZh,
    reasonZh: run.writing?.reasonZh ?? null,
    fact: run.structure?.fact ?? null,
  };
}

export interface AnalyzeResult {
  analysisId: number | null;
  stale: boolean;
  /** The article page is to be fetched first; nothing was committed. */
  needsBody?: boolean;
  output: ReturnType<typeof normalizeAnalysis> | null;
  receiptIds: number[];
  reused: boolean;
}

/**
 * Analyses the current revision and commits the judgement. A result computed for an older revision
 * is kept for traceability but never overwrites a newer input (stale = true).
 */
export async function analyzeArticle(articleId: string, opts: StepOpts = {}): Promise<AnalyzeResult | null> {
  const input = await loadAnalyzeInput(articleId);
  if (!input) return null;
  // Its page first; extraction queues the analysis again (normally the queue already routed it there).
  if (waitsForPage(input)) return { analysisId: null, stale: false, needsBody: true, output: null, receiptIds: [], reused: true };
  const run = await runAnalysis(input, opts);
  const out = normalizeAnalysis(run);
  const receiptIds = [
    ...(run.prefilter ? [run.prefilter.receiptId] : []), ...(run.scores?.receiptIds ?? []), ...(run.writing?.receiptIds ?? []), ...(run.structure ? [run.structure.receiptId] : []),
  ];
  const w = run.writing;
  const detail = {
    prefilter: run.prefilter ? { label: run.prefilter.label, inScope: out.inScope, reason: run.prefilter.reason } : null,
    ...(run.low ? { gate: { firstScore: run.low.first, floor: run.low.floor } } : {}),
    scores: out.scores, scoreModel: out.scoreModel, threshold: out.threshold,
    ...(run.scores?.projects ? { scoreBasis: "project", projectScores: run.scores.projects.map((p) => ({ projectId: p.project.id, values: p.values })) } : {}), ...(out.scoreRefused ? { scoreRefused: true } : {}),
    ...(w ? { writer: w.kind, writerModel: w.model, itemType: w.itemType ?? null, authorRole: w.authorRole ?? null } : {}),
    ...(w?.identityGuard?.outcome === "fallback" ? { identityGuard: w.identityGuard } : {}),
    fact: out.fact,
  };
  const committed = await sql.begin(async (tx) => {
    const [current] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${articleId} FOR UPDATE`;
    const stale = !current || current.revision !== input.revision;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, category, tags,
        subjects, title_zh, summary_zh, reason_zh, score, selected, in_scope, output)
      VALUES (${articleId}, ${input.revision}, 'model', ${w?.model ?? run.prefilter?.model ?? run.scores?.model ?? null}, ${ANALYZE_PROMPT_VERSION}, ${receiptIds},
        ${out.relevance}, ${out.category}, ${out.tags}, ${out.subjects}, ${out.titleZh}, ${out.summaryZh}, ${out.reasonZh},
        ${out.score}, ${out.selected}, ${out.inScope}, ${tx.json(detail as never)})
      RETURNING id`;
    if (!stale && run.scores?.projects && !run.scores.refused && input.source.id) {
      await storeProjectScores(tx, { id: input.id, sourceId: input.source.id, revision: input.revision }, run.scores.projects, { model: run.scores.model, receiptIds: run.scores.receiptIds });
    }
    for (const id of receiptIds) await completeReceipt(tx, id);
    if (!stale) {
      const state = out.relevance === "block" ? "blocked" : run.low ? "skipped" : "analyzed";
      const note = run.low ? `low first score: ${run.low.first} < ${run.low.floor}` : null;
      await tx`UPDATE articles SET processing_state = ${state}, processing_error = ${note} WHERE id = ${articleId}`;
    }
    return { analysisId: row!.id, stale };
  });
  const reused = (run.prefilter?.reused ?? true) && (run.scores?.reused ?? true) && (w?.reused ?? true) && (run.structure?.reused ?? true);
  return { analysisId: committed.analysisId, stale: committed.stale, output: out, receiptIds, reused };
}
