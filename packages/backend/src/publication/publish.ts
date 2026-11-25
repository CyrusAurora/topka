// Publishing: derive the editorial record of one article (the row projects and issues read) from its
// material, the latest judgement, manual overrides and grouping.
// Rebuilding only re-reads stored results; it never calls a model.
import { config } from "../config.ts";
import { one, sql, type Tx } from "../db.ts";
import { stableJson } from "../lib/ids.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import {
  bodyModeOf, channelOf, isPoolEligible, isSelectable, type SourceFacts,
} from "./rules.ts";

interface ArticleRow {
  id: string;
  source_id: string;
  url: string;
  title: string;
  language: string | null;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  backfill: boolean;
  body_status: string;
  body_text: string | null;
  x_post: unknown;
  grouped_at: Date | null;
}

interface AnalysisRow {
  id: number;
  relevance: string | null;
  category: string | null;
  tags: string[];
  subjects: string[];
  title_zh: string | null;
  summary_zh: string | null;
  reason_zh: string | null;
  score: number | null;
  selected: boolean | null;
  in_scope: boolean | null;
}

interface OverrideRow {
  fields: Record<string, unknown>;
  visibility: string | null;
}

interface PublicationRow {
  article_id: string;
  revision: number;
  visibility: string;
  eligible: boolean;
  selected: boolean;
  in_scope: boolean;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  body_mode: string;
  story_id: number | null;
  fact_id: number | null;
  selected_ready_at: Date | null;
  visible_after: Date | null;
}

export interface PublishOptions {
  now?: Date;
  /** Historical import: the item was already public, so it is released at its discovery time. */
  releasedAt?: Date | null;
}

export interface PublishResult {
  articleId: string;
  changed: boolean;
  selected: boolean;
  visibility: string;
  /** Something that was public is now shown less (withdrawn, out of the pool or selection, full text revoked). */
  reduced: boolean;
}

function pickString(override: unknown, fallback: string | null): string | null {
  return typeof override === "string" && override.trim() !== "" ? override.trim() : fallback;
}

function round1(n: number | null): number | null {
  return n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10;
}

export async function publishArticle(articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  return sql.begin((tx) => publishArticleTx(tx, articleId, options));
}

export async function publishArticleTx(tx: Tx, articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  const [article] = await tx<ArticleRow[]>`
    SELECT id, source_id, url, title, language, published_at, discovered_at, timeline_at, backfill, body_status,
           body_text, x_post, grouped_at
    FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (!article) return null;
  const now = options.now ?? new Date();
  const [source] = await tx<SourceFacts[]>`
    SELECT id, name, kind, tier, participation_mode, first_party, site_fulltext FROM sources WHERE id = ${article.source_id}`;
  if (!source) return null;
  const [analysis] = await tx<AnalysisRow[]>`
    SELECT id, relevance, category, tags, subjects, title_zh, summary_zh, reason_zh, score, selected, in_scope
    FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  const [override] = await tx<OverrideRow[]>`SELECT fields, visibility FROM editorial_overrides WHERE article_id = ${articleId}`;
  const [membership] = await tx<{ fact_id: number; story_id: number | null }[]>`
    SELECT fa.fact_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    LEFT JOIN stories s ON s.id = f.story_id
    WHERE fa.article_id = ${articleId} AND fa.role IN ('primary', 'report') AND (s.id IS NULL OR s.merged_into IS NULL)
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  const [previous] = await tx<PublicationRow[]>`SELECT * FROM publications WHERE article_id = ${articleId}`;

  const f = override?.fields ?? {};
  const isChineseTitle = article.language === "zh" || /[一-鿿]/.test(article.title);
  // An X post carries its Chinese in the summary and translation; without a Chinese title its own
  // text is the title, where an article would still be a half-finished card.
  const zhTitle = analysis?.title_zh?.trim() ? analysis.title_zh : null;
  const title = pickString(f.title, zhTitle ?? (isChineseTitle || article.x_post ? collapseWhitespace(article.title) : null));
  const summary = pickString(f.summary, analysis?.summary_zh ?? null);
  const category = pickString(f.category, analysis?.category ?? null);
  const tags = Array.isArray(f.tags) ? (f.tags as string[]) : [...new Set([...(analysis?.tags ?? []), ...(analysis?.subjects ?? []).map((s) => `entity:${s}`)])];
  const score = typeof f.score === "number" ? f.score : analysis?.score ?? null;
  const relevance = typeof f.relevance === "string" ? (f.relevance as string) : analysis?.relevance ?? null;
  const judgedSelected = typeof f.selected === "boolean" ? (f.selected as boolean) : analysis?.selected ?? null;
  // Material from an isolated source reaches no public surface at all: not even a detail page.
  const visibility = source.participation_mode === "isolated" ? "withdrawn" : (override?.visibility ?? "public");

  // Passed for a following project only (battery, earnings…): its projects see it, the public does not.
  const inScope = typeof f.inScope === "boolean" ? (f.inScope as boolean) : analysis?.in_scope ?? true;
  // A withdrawn observation (article_withdrawals) leaves the pool: projects stop seeing it as current evidence.
  const [withdrawal] = await tx<{ withdrawn: boolean }[]>`SELECT withdrawn FROM article_withdrawal_state WHERE article_id = ${articleId}`;
  const eligible = !withdrawal?.withdrawn && isPoolEligible({ participationMode: source.participation_mode, relevance, title, summary });
  const selected = inScope && isSelectable(eligible, judgedSelected, source.tier);
  const reason = selected ? pickString(f.reason, analysis?.reason_zh ?? null) : null;
  const hasXPost = !!article.x_post;
  const channel = channelOf(source.kind, hasXPost);
  const bodyMode = bodyModeOf(source, article.body_status, !!article.body_text && article.body_text.length > 0);
  const originalTitle = isChineseTitle && title === collapseWhitespace(article.title) ? null : collapseWhitespace(article.title);

  // Release gate: first time the item met the selected conditions, released after grouping or 180 s.
  let selectedReadyAt = previous?.selected_ready_at ?? null;
  let visibleAfter = previous?.visible_after ?? null;
  if (selected && !selectedReadyAt) {
    selectedReadyAt = options.releasedAt ?? now;
    visibleAfter = options.releasedAt
      ? options.releasedAt
      : article.grouped_at && article.grouped_at <= now
        ? now
        : new Date(now.getTime() + config.selectedVisibleAfterSeconds * 1000);
  } else if (selected && visibleAfter && visibleAfter > now && article.grouped_at && article.grouped_at <= now) {
    const earliest = new Date(Math.max(selectedReadyAt!.getTime(), article.grouped_at.getTime()));
    if (earliest < visibleAfter) {
      // A grouping decision can predate publication.
      visibleAfter = new Date(Math.max(earliest.getTime(), now.getTime()));
    }
  }

  const next = {
    visibility, eligible, selected, in_scope: inScope, title: title ?? collapseWhitespace(article.title), original_title: originalTitle, summary, reason,
    category, tags, score: round1(score), body_mode: bodyMode, story_id: membership?.story_id ?? null, fact_id: membership?.fact_id ?? null,
  };
  const changed =
    !previous ||
    stableJson({ ...next, tags: [...next.tags].sort() }) !==
      stableJson({
        visibility: previous.visibility, eligible: previous.eligible, selected: previous.selected, in_scope: previous.in_scope, title: previous.title,
        original_title: previous.original_title, summary: previous.summary, reason: previous.reason, category: previous.category,
        tags: [...previous.tags].sort(), score: previous.score === null ? null : Number(previous.score), body_mode: previous.body_mode,
        story_id: previous.story_id, fact_id: previous.fact_id,
      });
  const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;

  await tx`
    INSERT INTO publications (article_id, analysis_id, revision, visibility, eligible, selected, in_scope, title, original_title, summary,
      reason, category, tags, score, source_id, channel, first_party, url, published_at, discovered_at, timeline_at, backfill,
      selected_ready_at, visible_after, body_mode, story_id, fact_id, updated_at)
    VALUES (${articleId}, ${analysis?.id ?? null}, ${revision}, ${visibility}, ${eligible}, ${selected}, ${inScope}, ${next.title},
      ${originalTitle}, ${summary}, ${reason}, ${category}, ${tags}, ${next.score}, ${source.id}, ${channel}, ${source.first_party},
      ${article.url}, ${article.published_at}, ${article.discovered_at}, ${article.timeline_at}, ${article.backfill},
      ${selectedReadyAt}, ${visibleAfter}, ${bodyMode}, ${next.story_id}, ${next.fact_id}, now())
    ON CONFLICT (article_id) DO UPDATE SET
      analysis_id = EXCLUDED.analysis_id, revision = EXCLUDED.revision, visibility = EXCLUDED.visibility,
      eligible = EXCLUDED.eligible, selected = EXCLUDED.selected, in_scope = EXCLUDED.in_scope, title = EXCLUDED.title, original_title = EXCLUDED.original_title,
      summary = EXCLUDED.summary, reason = EXCLUDED.reason, category = EXCLUDED.category, tags = EXCLUDED.tags,
      score = EXCLUDED.score, source_id = EXCLUDED.source_id, channel = EXCLUDED.channel, first_party = EXCLUDED.first_party,
      url = EXCLUDED.url, published_at = EXCLUDED.published_at, discovered_at = EXCLUDED.discovered_at,
      timeline_at = EXCLUDED.timeline_at, backfill = EXCLUDED.backfill, selected_ready_at = EXCLUDED.selected_ready_at,
      visible_after = EXCLUDED.visible_after, body_mode = EXCLUDED.body_mode,
      story_id = EXCLUDED.story_id, fact_id = EXCLUDED.fact_id, updated_at = now(),
      -- Entering the pool later (ineligible before) counts as listed now, for "new since last read".
      listed_at = CASE WHEN EXCLUDED.eligible AND NOT publications.eligible THEN now() ELSE publications.listed_at END
    WHERE (publications.analysis_id, publications.revision, publications.visibility, publications.eligible,
        publications.selected, publications.in_scope, publications.title, publications.original_title, publications.summary,
        publications.reason, publications.category, publications.tags, publications.score,
        publications.source_id, publications.channel, publications.first_party, publications.url,
        publications.published_at, publications.discovered_at, publications.timeline_at, publications.backfill,
        publications.selected_ready_at, publications.visible_after, publications.body_mode,
        publications.story_id, publications.fact_id)
      IS DISTINCT FROM (EXCLUDED.analysis_id, EXCLUDED.revision, EXCLUDED.visibility, EXCLUDED.eligible,
        EXCLUDED.selected, EXCLUDED.in_scope, EXCLUDED.title, EXCLUDED.original_title, EXCLUDED.summary,
        EXCLUDED.reason, EXCLUDED.category, EXCLUDED.tags, EXCLUDED.score,
        EXCLUDED.source_id, EXCLUDED.channel, EXCLUDED.first_party, EXCLUDED.url,
        EXCLUDED.published_at, EXCLUDED.discovered_at, EXCLUDED.timeline_at, EXCLUDED.backfill,
        EXCLUDED.selected_ready_at, EXCLUDED.visible_after, EXCLUDED.body_mode,
        EXCLUDED.story_id, EXCLUDED.fact_id)`;

  const wasPublic = !!previous && previous.visibility !== "withdrawn" && previous.eligible;
  const reduced =
    wasPublic &&
    (visibility === "withdrawn" || !eligible ||
      (previous!.visibility === "public" && visibility !== "public") ||
      (previous!.selected && !selected) ||
      (previous!.body_mode === "full" && bodyMode !== "full"));
  return { articleId, changed, selected, visibility, reduced };
}

/**
 * Re-derives every published article of one source (after its participation, licences, tier or name
 * changed) without calling models. Runs in the worker; progress goes to the callback.
 */
export async function republishSource(sourceId: string, onProgress?: (done: number, total: number) => Promise<void>): Promise<{ total: number; changed: number; reduced: number }> {
  const { total } = one(await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM publications WHERE source_id = ${sourceId}`);
  let after = "";
  let done = 0;
  let changed = 0;
  let reduced = 0;
  for (;;) {
    const batch = await sql<{ article_id: string }[]>`
      SELECT article_id FROM publications WHERE source_id = ${sourceId} AND article_id > ${after} ORDER BY article_id LIMIT 500`;
    if (batch.length === 0) break;
    for (const { article_id } of batch) {
      // Stopping mid-way is safe: the job is retried after the restart and re-derives from the start.
      if (shutdownSignal.signal.aborted) throw new Error("worker is stopping; republish resumes after restart");
      const r = await publishArticle(article_id);
      if (r?.changed) changed += 1;
      if (r?.reduced) reduced += 1;
    }
    done += batch.length;
    after = batch[batch.length - 1]!.article_id;
    await onProgress?.(done, total);
  }
  return { total, changed, reduced };
}
