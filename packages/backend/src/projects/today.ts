// The per-project today view (master design J4; the checkpoint in its first, simple form of 3.3):
// a fixed number of cards (TODAY_CARD_COUNT, 3–5, default 3) from the published items of the project's
// linked sources that entered the pool since the reader last confirmed, ordered by the project score
// (project-score.ts), one card per event (grouped stories never take two slots). There is no floor and
// no overflow list: the rest is not important. A day whose cards average below QUIET_DAY_MEAN is
// flagged quiet, so a reader can be told the day was quiet. Reading never moves the checkpoint; only acknowledgeToday does,
// and only forward. Nothing qualifying is a first-class result ("无重要变化"), never an error.
// The same payload is what the snapshot export writes.
import { sql, type Db } from "../db.ts";
import type { OwnedProject } from "../publication/project-owner.ts";

export const TODAY_SCHEMA_VERSION = 2;
/** Without a checkpoint, "today" is the last 24 hours; an old checkpoint looks back at most 7 days. */
export const DEFAULT_WINDOW_HOURS = 24;
export const MAX_WINDOW_DAYS = 7;
export const DEFAULT_CARD_COUNT = 3;
export const MIN_CARD_COUNT = 3;
export const MAX_CARD_COUNT = 5;
/** The cards' mean project score below which the day is quiet. */
export const QUIET_DAY_MEAN = 50;

/** TODAY_CARD_COUNT, 3..5; anything else is the default 3. */
export function todayCardCount(env = process.env.TODAY_CARD_COUNT): number {
  const n = Number(env);
  return Number.isInteger(n) && n >= MIN_CARD_COUNT && n <= MAX_CARD_COUNT ? n : DEFAULT_CARD_COUNT;
}

export const NO_CHANGE_TITLE = "无重要变化";
export const NO_CHANGE_DETAIL = "自上次阅读以来，关注的来源里没有达到重要更新条件的新内容。这不表示什么都没发生。";
export const TODAY_NOTICE = "全部内容仅为发布方声明、未独立核验；中文标题和摘要由模型生成，是分析，不是证据，以原文为准。";

export type TodayResult = "updates-available" | "no-important-change";

export interface TodayItem {
  id: string;
  /** Chinese title when the analysis produced one, else the original. */
  title: string;
  originalTitle: string | null;
  /** Model-written Chinese summary (analysis, not evidence); null when there is none. */
  summary: string | null;
  url: string;
  source: { id: string; name: string };
  publishedAt: string | null;
  /** When the item entered the pool: what "new since last read" is measured on. */
  listedAt: string;
  selected: boolean;
  /** The project score (mean of the independent calls); the generic score while none exists yet. */
  score: number | null;
  scoreBasis: "project" | "generic" | null;
  /** The generic (fixed-reader) score the analysis stored, for comparison. */
  genericScore: number | null;
  /** The event (story) the card stands for; null while ungrouped. */
  storyId: string | null;
}

export interface TodayPayload {
  schemaVersion: number;
  kind: "project-today";
  project: { id: string; slug: string; target: string; purpose: string };
  generatedAt: string;
  /** Left-open, right-closed: listedAt > since and <= until. `until` is what an acknowledgement sends back. */
  window: { since: string; until: string; basis: "checkpoint" | "default" | "capped" };
  checkpoint: { readThrough: string | null };
  sources: { linked: number; active: number };
  result: TodayResult;
  emptyState: { title: string; detail: string } | null;
  items: TodayItem[];
  /** The card count in force (TODAY_CARD_COUNT). */
  cardCount: number;
  /** Distinct events that qualified; at most cardCount are shown. */
  candidates: number;
  /** The shown cards' mean score is below QUIET_DAY_MEAN (true when no card has a score). */
  quietDay: boolean;
  /** Mean score of the shown cards that have one; null when none has. */
  cardsMean: number | null;
  /** Collected from the linked sources in the window but not analysed yet (not shown). */
  awaitingAnalysis: number;
  notice: string;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function readCheckpoint(userId: string, projectId: string, db: Db = sql): Promise<Date | null> {
  const [row] = await db<{ read_through: Date }[]>`
    SELECT read_through FROM project_read_checkpoints WHERE user_id = ${userId} AND project_id = ${projectId}`;
  return row?.read_through ?? null;
}

/** First-import items published within this many hours count as today's news. */
export const RECENT_IMPORT_HOURS = 24;

/**
 * `record`: remember which articles reached the cards (project_today_shown, for the monthly source
 * report); the API and the snapshot export record, tests and previews need not.
 */
export async function buildToday(project: OwnedProject, userId: string, opts: { now?: Date; cards?: number; db?: Db; record?: boolean } = {}): Promise<TodayPayload> {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  const limit = opts.cards ?? todayCardCount();
  const checkpoint = await readCheckpoint(userId, project.id, db);
  const floor = new Date(now.getTime() - MAX_WINDOW_DAYS * 86_400_000);
  let since: Date;
  let basis: TodayPayload["window"]["basis"];
  if (!checkpoint) [since, basis] = [new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000), "default"];
  else if (checkpoint < floor) [since, basis] = [floor, "capped"];
  else [since, basis] = [checkpoint, "checkpoint"];

  const [counts] = await db<{ linked: number; active: number }[]>`
    SELECT count(*)::int AS linked, count(*) FILTER (WHERE s.enabled AND NOT ps.paused)::int AS active
    FROM project_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.project_id = ${project.id}`;

  // Listed like the public pool (eligible, public, a selected item only after its release gate);
  // a selected item counts from the moment it became visible.
  const rows = await db<Array<{
    id: string; title: string; original_title: string | null; summary: string | null; url: string; source_id: string; source_name: string;
    published_at: Date | null; listed_at: Date; selected: boolean; generic: string | null; project_score: number | null; story: string | null; candidates: number;
  }>>`
    WITH linked AS (
      SELECT ps.source_id FROM project_sources ps JOIN sources s ON s.id = ps.source_id
      WHERE ps.project_id = ${project.id} AND s.enabled AND NOT ps.paused
    ), listed AS (
      SELECT p.*, greatest(p.listed_at, coalesce(p.visible_after, p.listed_at)) AS entered_at
      FROM publications p JOIN articles a ON a.id = p.article_id
      WHERE p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${now})
        -- From a linked source, or listed by one too: a broad feed may have stored the same URL first.
        AND (p.source_id IN (SELECT source_id FROM linked)
             OR EXISTS (SELECT 1 FROM article_discoveries d JOIN linked l ON l.source_id = d.source_id WHERE d.article_id = p.article_id))
        -- History stays out, except a source's first import of items it published in the last 24 hours:
        -- a newly added source's current news is news.
        AND (NOT p.backfill OR (a.backfill_reason = 'first-import' AND p.published_at > ${new Date(now.getTime() - RECENT_IMPORT_HOURS * 3_600_000)} AND p.published_at <= ${now}))
    ), scored AS (
      SELECT x.*, ps.score AS project_score, coalesce(ps.score::numeric, x.score) AS effective,
             coalesce(st.merged_into, st.id)::text AS story
      FROM listed x
      LEFT JOIN project_scores ps ON ps.project_id = ${project.id} AND ps.article_id = x.article_id
      LEFT JOIN stories st ON st.id = x.story_id
      WHERE x.entered_at > ${since} AND x.entered_at <= ${now}
    ), ranked AS (
      -- One card per event: the event's best-scored report stands for it.
      SELECT y.*, row_number() OVER (PARTITION BY coalesce('s:' || y.story, 'a:' || y.article_id)
                                     ORDER BY y.effective DESC NULLS LAST, y.entered_at DESC, y.article_id) AS rank_in_event
      FROM scored y
    )
    SELECT r.article_id AS id, r.title, r.original_title, r.summary, r.url, r.source_id, s.name AS source_name,
           r.published_at, r.entered_at AS listed_at, r.selected, r.score::text AS generic, r.project_score, r.story,
           count(*) OVER ()::int AS candidates
    FROM ranked r JOIN sources s ON s.id = r.source_id
    WHERE r.rank_in_event = 1
    ORDER BY r.effective DESC NULLS LAST, r.entered_at DESC, r.article_id
    LIMIT ${limit}`;
  const candidates = rows[0]?.candidates ?? 0;
  const items: TodayItem[] = rows.map((r) => {
    const generic = r.generic === null ? null : Number(r.generic);
    const score = r.project_score ?? generic;
    return {
      id: r.id, title: r.title, originalTitle: r.original_title && r.original_title !== r.title ? r.original_title : null, summary: r.summary,
      url: r.url, source: { id: r.source_id, name: r.source_name }, publishedAt: iso(r.published_at), listedAt: iso(r.listed_at)!,
      selected: r.selected, score, scoreBasis: r.project_score !== null ? "project" : generic !== null ? "generic" : null, genericScore: generic, storyId: r.story,
    };
  });
  // Over the cards that carry a score (an unscored card neither lifts nor sinks the day).
  const scoredCards = items.filter((i) => i.score !== null);
  const cardsMean = scoredCards.length ? Math.round((scoredCards.reduce((t, i) => t + i.score!, 0) / scoredCards.length) * 10) / 10 : null;
  if (opts.record && items.length) {
    for (const [i, r] of rows.entries()) {
      await db`INSERT INTO project_today_shown (project_id, article_id, source_id, score) VALUES (${project.id}, ${r.id}, ${r.source_id}, ${items[i]!.score})
               ON CONFLICT (project_id, article_id) DO NOTHING`;
    }
  }

  const [pending] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM articles a
    JOIN project_sources ps ON ps.source_id = a.source_id AND ps.project_id = ${project.id} AND NOT ps.paused
    JOIN sources s ON s.id = a.source_id AND s.enabled
    LEFT JOIN publications p ON p.article_id = a.id
    WHERE p.article_id IS NULL AND a.processing_state = 'new' AND a.created_at > ${since} AND a.created_at <= ${now}`;

  const result: TodayResult = items.length > 0 ? "updates-available" : "no-important-change";
  return {
    schemaVersion: TODAY_SCHEMA_VERSION,
    kind: "project-today",
    project: { id: project.id, slug: project.slug, target: project.target, purpose: project.purpose },
    generatedAt: now.toISOString(),
    window: { since: since.toISOString(), until: now.toISOString(), basis },
    checkpoint: { readThrough: iso(checkpoint) },
    sources: { linked: counts?.linked ?? 0, active: counts?.active ?? 0 },
    result,
    emptyState: result === "no-important-change" ? { title: NO_CHANGE_TITLE, detail: NO_CHANGE_DETAIL } : null,
    items,
    cardCount: limit,
    candidates,
    quietDay: cardsMean === null || cardsMean < QUIET_DAY_MEAN,
    cardsMean,
    awaitingAnalysis: pending?.n ?? 0,
    notice: TODAY_NOTICE,
  };
}

export class AckRejected extends Error {
  readonly reason: "invalid-through" | "future-through";
  constructor(reason: AckRejected["reason"]) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * The reader confirms having read up to `through` (the window.until of the payload they saw). The
 * checkpoint only moves forward: an older or equal `through` leaves it where it is (idempotent).
 */
export async function acknowledgeToday(userId: string, projectId: string, through: Date, opts: { now?: Date; db?: Db } = {}) {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  if (Number.isNaN(through.getTime())) throw new AckRejected("invalid-through");
  // A little clock skew between the page and the server is fine; a checkpoint in the future is not.
  if (through.getTime() > now.getTime() + 60_000) throw new AckRejected("future-through");
  const at = through.getTime() > now.getTime() ? now : through;
  const [row] = await db<{ read_through: Date; acks: number; advanced: boolean }[]>`
    WITH prev AS (SELECT read_through FROM project_read_checkpoints WHERE user_id = ${userId} AND project_id = ${projectId})
    INSERT INTO project_read_checkpoints (user_id, project_id, read_through) VALUES (${userId}, ${projectId}, ${at})
    ON CONFLICT (user_id, project_id) DO UPDATE SET
      read_through = greatest(project_read_checkpoints.read_through, EXCLUDED.read_through),
      acks = project_read_checkpoints.acks + CASE WHEN EXCLUDED.read_through > project_read_checkpoints.read_through THEN 1 ELSE 0 END,
      updated_at = CASE WHEN EXCLUDED.read_through > project_read_checkpoints.read_through THEN now() ELSE project_read_checkpoints.updated_at END
    RETURNING read_through, acks, (SELECT read_through FROM prev) IS DISTINCT FROM read_through AS advanced`;
  return { readThrough: row!.read_through.toISOString(), advanced: row!.advanced };
}
