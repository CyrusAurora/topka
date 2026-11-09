// The per-user today view (今日): one short list across all of the user's active
// projects. Candidates of every project are merged, an article followed by several projects counts once
// with its best project score, one card per event, the top TODAY_CARD_COUNT (3–5, default 3). The
// reader's marks (看过了 / 稍后看) ride on the cards; markItem stays for old clients. Same rules as the
// per-project view (today.ts) otherwise. Clients now read the v4.4 issues.ts instead: this
// module remains for the web export script and the card-copy script.
import { sql, type Db } from "../db.ts";
import { cardCopyFor, writeCardCopy, type CardCopy } from "./card-copy.ts";
import { capPerSource, nextIssueAtInTz, DEFAULT_TIMEZONE } from "./issue-rules.ts";
import {
  AckRejected, DEFAULT_WINDOW_HOURS, MAX_WINDOW_DAYS, NO_CHANGE_DETAIL, NO_CHANGE_TITLE, QUIET_DAY_MEAN, RECENT_IMPORT_HOURS, TODAY_NOTICE,
  todayCardCount, type TodayResult,
} from "./today.ts";

// 2: items[].card, the mobile card copy (title / lead / why) when it has been written.
export const USER_TODAY_SCHEMA_VERSION = 2;
export const QUIET_DAY_NOTE = "今天没大事";

export interface UserTodayItem {
  /** Copy written for the phone card (null until written; the card then uses title and summary). */
  card: CardCopy | null;
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  url: string;
  source: { id: string; name: string };
  /** The project the card counts for (its best score), and every project of the user that follows it. */
  project: { id: string; slug: string; target: string };
  projectIds: string[];
  publishedAt: string | null;
  listedAt: string;
  selected: boolean;
  score: number | null;
  scoreBasis: "project" | "generic" | null;
  genericScore: number | null;
  storyId: string | null;
  mark: "seen" | "later" | null;
}

export interface UserTodayPayload {
  schemaVersion: number;
  kind: "user-today";
  user: { id: string };
  projects: Array<{ id: string; slug: string; target: string; purpose: string; focus: string; exclusions: string; sources: number; createdAt: string }>;
  generatedAt: string;
  window: { since: string; until: string; basis: "checkpoint" | "default" | "capped" | "finished" };
  checkpoint: { readThrough: string | null; freshAt: string | null };
  /** The day is finished: the window is frozen until the next 08:00 local in the user's timezone. */
  dayDone: boolean;
  result: TodayResult;
  emptyState: { title: string; detail: string } | null;
  items: UserTodayItem[];
  cardCount: number;
  candidates: number;
  quietDay: boolean;
  quietNote: string | null;
  cardsMean: number | null;
  /** The card most worth remembering: the best-scored one. */
  bestId: string | null;
  /** Items marked 稍后看 earlier (not on today's cards), newest first, at most 10. */
  later: Array<{ id: string; title: string; url: string; source: string; markedAt: string }>;
  notice: string;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The next 08:00 Asia/Shanghai strictly after `now` (legacy wrapper; prefer nextFreshAtInTz). */
export function nextFreshAt(now: Date): Date {
  return nextIssueAtInTz(now, DEFAULT_TIMEZONE);
}

/** The next 08:00 local in `tz` strictly after `now`: when a finished day turns for that user. */
export function nextFreshAtInTz(now: Date, tz: string): Date {
  return nextIssueAtInTz(now, tz);
}

interface CheckpointRow {
  read_through: Date | null;
  day_since: Date | null;
  day_until: Date | null;
  fresh_at: Date | null;
}

async function readCheckpointRow(userId: string, db: Db): Promise<CheckpointRow | null> {
  const [row] = await db<CheckpointRow[]>`
    SELECT read_through, day_since, day_until, fresh_at FROM user_read_checkpoints WHERE user_id = ${userId}`;
  return row ?? null;
}

/** PostgreSQL's greatest(): the larger of the two, null when both are null. */
function greatestDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

export async function readUserCheckpoint(userId: string, db: Db = sql): Promise<Date | null> {
  const [row] = await db<{ read_through: Date | null }[]>`SELECT read_through FROM user_read_checkpoints WHERE user_id = ${userId}`;
  return row?.read_through ?? null;
}

export async function listUserProjects(userId: string, db: Db = sql): Promise<UserTodayPayload["projects"]> {
  return db<UserTodayPayload["projects"]>`
    SELECT p.id, p.slug, p.target, p.purpose, p.focus, p.exclusions, to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
           (SELECT count(*)::int FROM project_sources ps WHERE ps.project_id = p.id) AS sources
    FROM tracking_projects p WHERE p.owner_id = ${userId} AND p.status = 'active' ORDER BY p.created_at, p.id`;
}

export async function buildUserToday(userId: string, opts: { now?: Date; cards?: number; db?: Db; record?: boolean } = {}): Promise<UserTodayPayload> {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  const limit = opts.cards ?? todayCardCount();
  const cp = await readCheckpointRow(userId, db);
  const floor = new Date(now.getTime() - MAX_WINDOW_DAYS * 86_400_000);
  const freshAt = cp?.fresh_at ?? null;
  // A finished day stays frozen on its own window until the next 08:00 local in the user's timezone.
  const frozen = freshAt !== null && freshAt.getTime() > now.getTime();
  let since: Date;
  let until: Date;
  let basis: UserTodayPayload["window"]["basis"];
  if (frozen) {
    since = cp?.day_since ?? new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000);
    until = cp?.day_until ?? now;
    basis = "finished";
  } else {
    // The finished day's finish point is the checkpoint from then on.
    const checkpoint = greatestDate(cp?.read_through ?? null, freshAt !== null ? cp?.day_until ?? null : null);
    until = now;
    if (!checkpoint) [since, basis] = [new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000), "default"];
    else if (checkpoint < floor) [since, basis] = [floor, "capped"];
    else [since, basis] = [checkpoint, "checkpoint"];
  }
  const projects = await listUserProjects(userId, db);

  const ranked = await db<Array<{
    id: string; title: string; original_title: string | null; summary: string | null; url: string; source_id: string; source_name: string;
    published_at: Date | null; listed_at: Date; selected: boolean; generic: string | null; project_score: number | null; story: string | null;
    project_id: string; project_ids: string[]; mark: "seen" | "later" | null; candidates: number;
  }>>`
    WITH mine AS (
      SELECT id FROM tracking_projects WHERE owner_id = ${userId} AND status = 'active'
    ), linked AS (
      SELECT ps.project_id, ps.source_id FROM project_sources ps JOIN mine m ON m.id = ps.project_id JOIN sources s ON s.id = ps.source_id
      WHERE s.enabled AND NOT ps.paused
    ), listed AS (
      SELECT p.*, l.project_id, greatest(p.listed_at, coalesce(p.visible_after, p.listed_at)) AS entered_at
      FROM publications p JOIN linked l ON l.source_id = p.source_id JOIN articles a ON a.id = p.article_id
      WHERE p.visibility = 'public' AND p.in_scope AND p.eligible AND (NOT p.selected OR p.visible_after <= ${now})
        AND (NOT p.backfill OR (a.backfill_reason = 'first-import' AND p.published_at > ${new Date(now.getTime() - RECENT_IMPORT_HOURS * 3_600_000)} AND p.published_at <= ${now}))
    ), scored AS (
      SELECT x.*, sc.score AS project_score, coalesce(sc.score::numeric, x.score) AS effective
      FROM listed x LEFT JOIN project_scores sc ON sc.project_id = x.project_id AND sc.article_id = x.article_id
      WHERE x.entered_at > ${since} AND x.entered_at <= ${until}
    ), per_article AS (
      -- An article several projects follow: once, under its best project.
      SELECT DISTINCT ON (y.article_id) y.*, array_agg(y.project_id) OVER (PARTITION BY y.article_id) AS project_ids
      FROM scored y ORDER BY y.article_id, y.effective DESC NULLS LAST, y.project_id
    ), ranked AS (
      SELECT z.*, coalesce(st.merged_into, st.id)::text AS story,
             row_number() OVER (PARTITION BY coalesce('s:' || coalesce(st.merged_into, st.id)::text, 'a:' || z.article_id)
                                ORDER BY z.effective DESC NULLS LAST, z.entered_at DESC, z.article_id) AS rank_in_event
      FROM per_article z LEFT JOIN stories st ON st.id = z.story_id
    )
    SELECT r.article_id AS id, r.title, r.original_title, r.summary, r.url, r.source_id, s.name AS source_name, r.published_at,
           r.entered_at AS listed_at, r.selected, r.score::text AS generic, r.project_score, r.story, r.project_id, r.project_ids,
           m.mark, count(*) OVER ()::int AS candidates
    FROM ranked r JOIN sources s ON s.id = r.source_id
    LEFT JOIN user_item_marks m ON m.user_id = ${userId} AND m.article_id = r.article_id
    WHERE r.rank_in_event = 1 AND (m.mark IS NULL OR m.at > ${since})
    ORDER BY r.effective DESC NULLS LAST, r.entered_at DESC, r.article_id`;
  // The same per-source cap as the issue (capPerSource), so no single source fills the cards.
  const rows = capPerSource(ranked, limit, (r) => r.source_id);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const items: UserTodayItem[] = rows.map((r) => {
    const generic = r.generic === null ? null : Number(r.generic);
    const score = r.project_score ?? generic;
    const p = byId.get(r.project_id);
    return {
      card: null,
      id: r.id, title: r.title, originalTitle: r.original_title && r.original_title !== r.title ? r.original_title : null, summary: r.summary,
      url: r.url, source: { id: r.source_id, name: r.source_name }, project: { id: r.project_id, slug: p?.slug ?? "", target: p?.target ?? "" },
      projectIds: [...new Set(r.project_ids)].sort(), publishedAt: iso(r.published_at), listedAt: iso(r.listed_at)!, selected: r.selected, score,
      scoreBasis: r.project_score !== null ? "project" : generic !== null ? "generic" : null, genericScore: generic, storyId: r.story, mark: r.mark,
    };
  });
  const copy = await cardCopyFor(items.map((i) => ({ projectId: i.project.id, articleId: i.id })), db);
  for (const i of items) i.card = copy.get(`${i.project.id}:${i.id}`) ?? null;
  const scoredCards = items.filter((i) => i.score !== null);
  const cardsMean = scoredCards.length ? Math.round((scoredCards.reduce((t, i) => t + i.score!, 0) / scoredCards.length) * 10) / 10 : null;
  const quietDay = cardsMean === null || cardsMean < QUIET_DAY_MEAN;
  const best = scoredCards.reduce<UserTodayItem | null>((b, i) => (!b || i.score! > b.score! ? i : b), null) ?? items[0] ?? null;
  if (opts.record) {
    for (const i of items) {
      await db`INSERT INTO project_today_shown (project_id, article_id, source_id, score) VALUES (${i.project.id}, ${i.id}, ${i.source.id}, ${i.score})
               ON CONFLICT (project_id, article_id) DO NOTHING`;
    }
  }
  const shown = new Set(items.map((i) => i.id));
  const later = (await db<{ id: string; title: string; url: string; source: string; at: Date }[]>`
    SELECT m.article_id AS id, p.title, p.url, s.name AS source, m.at FROM user_item_marks m
    JOIN publications p ON p.article_id = m.article_id JOIN sources s ON s.id = p.source_id
    WHERE m.user_id = ${userId} AND m.mark = 'later' AND m.at > ${floor} ORDER BY m.at DESC LIMIT 13`)
    .filter((l) => !shown.has(l.id)).slice(0, 10).map((l) => ({ id: l.id, title: l.title, url: l.url, source: l.source, markedAt: l.at.toISOString() }));
  const result: TodayResult = items.length ? "updates-available" : "no-important-change";
  return {
    schemaVersion: USER_TODAY_SCHEMA_VERSION,
    kind: "user-today",
    user: { id: userId },
    projects,
    generatedAt: now.toISOString(),
    window: { since: since.toISOString(), until: until.toISOString(), basis },
    checkpoint: { readThrough: iso(cp?.read_through ?? null), freshAt: frozen ? freshAt!.toISOString() : null },
    dayDone: frozen,
    result,
    emptyState: result === "no-important-change" ? { title: NO_CHANGE_TITLE, detail: NO_CHANGE_DETAIL } : null,
    items,
    cardCount: limit,
    candidates: rows[0]?.candidates ?? 0,
    quietDay,
    quietNote: items.length && quietDay ? QUIET_DAY_NOTE : null,
    cardsMean,
    bestId: best?.id ?? null,
    later,
    notice: TODAY_NOTICE,
  };
}

/** 看过了 / 稍后看 on one article; only an article from one of the user's projects' sources. null clears. */
export async function markItem(userId: string, articleId: string, mark: "seen" | "later" | null, db: Db = sql): Promise<boolean> {
  const [ok] = await db<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM articles a JOIN project_sources ps ON ps.source_id = a.source_id
                   JOIN tracking_projects p ON p.id = ps.project_id AND p.owner_id = ${userId} WHERE a.id = ${articleId}) AS ok`;
  if (!ok?.ok) return false;
  if (mark === null) await db`DELETE FROM user_item_marks WHERE user_id = ${userId} AND article_id = ${articleId}`;
  else await db`INSERT INTO user_item_marks (user_id, article_id, mark) VALUES (${userId}, ${articleId}, ${mark})
                ON CONFLICT (user_id, article_id) DO UPDATE SET mark = EXCLUDED.mark, at = now()`;
  return true;
}

/** 记住读到这里: the user's checkpoint moves to `through` (the payload's window.until), never backwards. */
export async function acknowledgeUserToday(userId: string, through: Date, opts: { now?: Date; db?: Db } = {}) {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  if (Number.isNaN(through.getTime())) throw new AckRejected("invalid-through");
  if (through.getTime() > now.getTime() + 60_000) throw new AckRejected("future-through");
  const at = through.getTime() > now.getTime() ? now : through;
  const [row] = await db<{ read_through: Date; advanced: boolean }[]>`
    WITH prev AS (SELECT read_through FROM user_read_checkpoints WHERE user_id = ${userId})
    INSERT INTO user_read_checkpoints (user_id, read_through) VALUES (${userId}, ${at})
    ON CONFLICT (user_id) DO UPDATE SET
      read_through = greatest(user_read_checkpoints.read_through, EXCLUDED.read_through),
      acks = user_read_checkpoints.acks + CASE WHEN EXCLUDED.read_through > user_read_checkpoints.read_through THEN 1 ELSE 0 END,
      updated_at = now()
    RETURNING read_through, (SELECT read_through FROM prev) IS DISTINCT FROM read_through AS advanced`;
  return { readThrough: row!.read_through.toISOString(), advanced: row!.advanced };
}

/** Writes the phone-card copy for a user's current top cards that have none (background budget only). */
export async function writeUserCardCopy(userId: string, db: Db = sql) {
  const today = await buildUserToday(userId, { db });
  const items = today.items.filter((i) => !i.card).map((i) => ({
    id: i.id, projectId: i.project.id, title: i.title, originalTitle: i.originalTitle, summary: i.summary, source: i.source.name, publishedAt: i.publishedAt,
  }));
  return writeCardCopy(items, { db, subject: `user:${userId}:cards` });
}
