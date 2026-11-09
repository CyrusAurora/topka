// The daily issue model: every day at 08:00 local in the user's timezone the server fixes that user's issue of
// up to ISSUE_SIZE items (top candidates in the window since the previous issue's cutoff, excluding
// anything shown in an earlier issue — an article or its whole event never comes back). When the issue
// is fixed it stops changing for that day; a later, better article waits for the next issue. A day
// with fewer than 3 fresh candidates is filled with the best never-shown candidates of the previous
// 72 hours (same gate), and an empty row only remains when even those are missing. The card copy
// (issue_card_copy) is written separately by the budgeted copy writer; until then the item falls back
// to the publication's own title and summary (v4.4 今日 / 往期).
import { sql, one, type Db } from "../db.ts";
import { SELECTION } from "@topka/industry/selection";
import { RECENT_IMPORT_HOURS } from "./today.ts";
import { listUserProjects } from "./user-today.ts";
import { capPerSource, isHero, isValidTimeZone, issueCutoffInTz, currentIssueDateInTz, nextIssueAtInTz, DEFAULT_TIMEZONE } from "./issue-rules.ts";

/** The user's IANA zone from the users row, falling back to the default (Shanghai). */
export async function userTimezone(userId: string, db: Db = sql): Promise<string> {
  const [row] = await db<{ timezone: string | null }[]>`SELECT timezone FROM users WHERE id = ${userId}`;
  return row?.timezone && isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE;
}

export const ISSUE_SCHEMA_VERSION = 3;
export const ISSUE_SIZE = 3;
/** Lowest score an item may have to enter an issue (industry/selection.ts issueFloor): fewer items rather than filler. */
export const ISSUE_MIN_SCORE = SELECTION.issueFloor;
/** How far back a short day is filled from. */
export const ISSUE_FILL_HOURS = 72;
export const AI_NOTICE = "AI 生成摘要，以原文为准";
export const AI_NOTICE_EN = "AI-generated summary; refer to the original";
/** Notice in the issue feed for the reader's locale (en → English, else Chinese). */
export function aiNoticeFor(locale: unknown): string {
  return locale === "en" || locale === "en-US" ? AI_NOTICE_EN : AI_NOTICE;
}
export async function userLocale(userId: string, db: Db = sql): Promise<string> {
  const [row] = await db<{ locale: string | null }[]>`SELECT locale FROM users WHERE id = ${userId}`;
  return row?.locale && (row.locale === "en" || row.locale === "zh-CN") ? row.locale : "zh-CN";
}

export interface IssueItem {
  id: string;
  position: number;
  title_a: string;
  title_b: string;
  core_a: string;
  core_b: string;
  summary: string;
  tag: string;
  source: string;
  url: string;
  score: number | null;
  project: { id: string; slug: string; target: string };
  publishedAt: string | null;
  listedAt: string;
  hasCopy: boolean;
  overBudget: boolean;
}

export interface Issue {
  date: string;
  no: number | null;
  fixedAt: string;
  hero: boolean;
  ready: boolean;
  items: IssueItem[];
}

export interface ArchiveEntry {
  date: string;
  no: number;
  titles: string[];
}

export interface UserIssuePayload {
  schemaVersion: number;
  kind: "user-issue";
  user: { id: string };
  projects: Array<{ id: string; slug: string; target: string }>;
  generatedAt: string;
  nextAt: string;
  issueCount: number;
  issue: Issue | null;
  opened: string[];
  archive: ArchiveEntry[];
  notice: string;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface IssueCandidate {
  article_id: string;
  project_id: string;
  source_id: string;
  story: string | null;
  score: number | null;
  listed_at: Date;
}

/**
 * The issue's candidate list: buildUserToday's ranking (mine/linked/listed/per_article/ranked, one
 * article per event, the window's `now` conditions at `until`), without the marks. Anything an earlier
 * issue already showed is out — the article itself (checked in `scored`, so a fresh article of an
 * already-shown event can still win its event) and its whole story (checked in the final WHERE).
 */
export async function issueCandidates(userId: string, since: Date, until: Date, db: Db = sql): Promise<IssueCandidate[]> {
  // Every candidate above the floor, in score order: the per-source cap (capPerSource) may have to
  // skip any number of one source's items, so the cut happens in code, not with LIMIT.
  return db<IssueCandidate[]>`
    WITH mine AS (
      SELECT id FROM tracking_projects WHERE owner_id = ${userId} AND status = 'active'
    ), linked AS (
      SELECT ps.project_id, ps.source_id FROM project_sources ps JOIN mine m ON m.id = ps.project_id JOIN sources s ON s.id = ps.source_id
      WHERE s.enabled AND NOT ps.paused
    ), listed AS (
      SELECT p.*, l.project_id, greatest(p.listed_at, coalesce(p.visible_after, p.listed_at)) AS entered_at
      FROM publications p JOIN linked l ON l.source_id = p.source_id JOIN articles a ON a.id = p.article_id
      -- The issue (每日 Top 3) is the site's scope only: an item a project follows outside it (battery,
      -- earnings…) stays in that project's own view.
      WHERE p.visibility = 'public' AND p.in_scope AND p.eligible AND (NOT p.selected OR p.visible_after <= ${until})
        AND (NOT p.backfill OR (a.backfill_reason = 'first-import' AND p.published_at > ${new Date(until.getTime() - RECENT_IMPORT_HOURS * 3_600_000)} AND p.published_at <= ${until}))
    ), scored AS (
      SELECT x.*, sc.score AS project_score, coalesce(sc.score::numeric, x.score) AS effective
      FROM listed x LEFT JOIN project_scores sc ON sc.project_id = x.project_id AND sc.article_id = x.article_id
      WHERE x.entered_at > ${since} AND x.entered_at <= ${until}
        AND NOT EXISTS (SELECT 1 FROM user_issue_items ui WHERE ui.user_id = ${userId} AND ui.article_id = x.article_id)
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
    SELECT r.article_id, r.project_id, r.source_id, r.story, r.effective AS score, r.entered_at AS listed_at
    FROM ranked r
    WHERE r.rank_in_event = 1 AND r.effective >= ${ISSUE_MIN_SCORE}
      AND (r.story IS NULL OR NOT EXISTS (SELECT 1 FROM user_issue_items ui WHERE ui.user_id = ${userId} AND ui.story_id = r.story))
    ORDER BY r.effective DESC NULLS LAST, r.entered_at DESC, r.article_id`;
}

const bySource = (c: IssueCandidate) => c.source_id;

/** True when the issue's date already has a row (fixed, or kept empty for the day). */
async function issueExists(userId: string, date: string, db: Db): Promise<boolean> {
  return Boolean((await db`SELECT 1 FROM user_issues WHERE user_id = ${userId} AND issue_date = ${date} LIMIT 1`).length);
}

type Sql = typeof sql;

/**
 * Fixes today's issue when this day's has not been fixed yet (idempotent: an advisory lock plus the
 * re-check inside the transaction, so concurrent calls agree on one writer). Returns
 * `{ created: false }` when today's row is there, null when there is nothing to write: the first ever
 * issue needs candidates (nothing shown yet — the client says 第一期正在准备), or the user has no active
 * project. Any later day always writes a row, empty or not (issue_no NULL for an empty day).
 */
export async function ensureIssue(userId: string, opts: { now?: Date; db?: Db } = {}): Promise<{ date: string; created: boolean } | null> {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  const tz = await userTimezone(userId, db);
  const date = currentIssueDateInTz(now, tz);
  if (await issueExists(userId, date, db)) return { date, created: false };
  const [active] = await db<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM tracking_projects WHERE owner_id = ${userId} AND status = 'active') AS ok`;
  if (!active?.ok) return null;
  const [prev] = await db<{ cutoff: Date | null }[]>`SELECT max(cutoff) AS cutoff FROM user_issues WHERE user_id = ${userId}`;
  const prevCutoff = prev?.cutoff ?? null;
  const first = prevCutoff === null;
  const cutoff = first ? now : issueCutoffInTz(date, tz);
  const since = first ? new Date(now.getTime() - 24 * 3_600_000) : new Date(Math.max(prevCutoff.getTime(), cutoff.getTime() - 7 * 86_400_000));

  const write = async (tx: Db): Promise<"exists" | "empty" | "written"> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`issue:${userId}`}))`;
    if (await issueExists(userId, date, tx)) return "exists";
    const items = capPerSource(await issueCandidates(userId, since, cutoff, tx), ISSUE_SIZE, bySource);
    const fresh = items.length;
    // A short day is filled from the days before this window that were never shown: the same gate
    // over the previous 72 hours, best first, until the issue is full. The first issue has no
    // earlier days to draw from.
    if (!first && items.length < ISSUE_SIZE) {
      const fillSince = new Date(cutoff.getTime() - ISSUE_FILL_HOURS * 3_600_000);
      if (fillSince < since) {
        // An earlier event the fresh window already shows stays out; the cap counts the fresh cards.
        const seenArticles = new Set(items.map((i) => i.article_id));
        const seenStories = new Set(items.map((i) => i.story).filter((s): s is string => s !== null));
        const earlier = (await issueCandidates(userId, fillSince, since, tx))
          .filter((c) => !seenArticles.has(c.article_id) && (c.story === null || !seenStories.has(c.story)));
        items.push(...capPerSource(earlier, ISSUE_SIZE, bySource, items));
      }
    }
    const filled = items.length - fresh;
    if (filled > 0) console.log(JSON.stringify({ level: "info", msg: "issue filled from earlier days", userId, date, fresh, filled }));
    if (items.length < ISSUE_SIZE) console.warn(JSON.stringify({ level: "warn", msg: "issue short", userId, date, items: items.length }));
    // The first ever issue needs candidates; nothing shows otherwise and nothing is written — the
    // client's 第一期正在准备. Every later day keeps a row, an empty day's issue_no stays NULL.
    if (first && !items.length) return "empty";
    const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM user_issues WHERE user_id = ${userId} AND issue_no IS NOT NULL`;
    await tx`INSERT INTO user_issues (user_id, issue_date, issue_no, cutoff, window_since, hero)
             VALUES (${userId}, ${date}, ${items.length ? n!.n + 1 : null}, ${cutoff}, ${since}, ${isHero(items.map((i) => i.score))})`;
    for (const [index, item] of items.entries()) {
      await tx`INSERT INTO user_issue_items (user_id, issue_date, position, article_id, project_id, story_id, score, listed_at)
               VALUES (${userId}, ${date}, ${index + 1}, ${item.article_id}, ${item.project_id}, ${item.story}, ${item.score}, ${item.listed_at})
               ON CONFLICT DO NOTHING`;
    }
    return "written";
  };
  // Already a transaction itself: postgres.js nests through savepoints, each waiter still serialises on the lock.
  const done = await ("begin" in db ? (db as Sql).begin(async (tx) => write(tx)) : write(db));
  if (done === "exists") return { date, created: false };
  if (done === "empty") return null;
  return { date, created: true };
}

/** One issue of the user, in order, with its card copy where there is any. */
export async function readIssue(userId: string, date: string, db: Db = sql): Promise<Issue | null> {
  const [head] = await db<{ issue_date: string; issue_no: number | null; fixed_at: Date; hero: boolean }[]>`
    SELECT to_char(issue_date, 'YYYY-MM-DD') AS issue_date, issue_no, fixed_at, hero
    FROM user_issues WHERE user_id = ${userId} AND issue_date = ${date}`;
  if (!head) return null;
  type Row = {
    position: number; article_id: string; score: number | null; listed_at: Date; published_at: Date | null; url: string; project_id: string; slug: string; target: string;
    p_title: string; p_summary: string | null; s_name: string;
    title_a: string | null; title_b: string | null; core_a: string | null; core_b: string | null; c_summary: string | null; tag: string | null; source_short: string | null; over_budget: boolean | null;
  };
  const rows = await db<Row[]>`
    SELECT ui.position, ui.article_id, ui.score, ui.listed_at, p.published_at, p.title AS p_title, p.summary AS p_summary, p.url,
           pr.id AS project_id, pr.slug, pr.target, s.name AS s_name,
           c.title_a, c.title_b, c.core_a, c.core_b, c.summary AS c_summary, c.tag, c.source_short, c.over_budget
    FROM user_issue_items ui
    JOIN publications p ON p.article_id = ui.article_id
    JOIN sources s ON s.id = p.source_id
    JOIN tracking_projects pr ON pr.id = ui.project_id
    LEFT JOIN issue_card_copy c ON c.project_id = ui.project_id AND c.article_id = ui.article_id
    WHERE ui.user_id = ${userId} AND ui.issue_date = ${date}
    ORDER BY ui.position`;
  const items: IssueItem[] = rows.map((r) => ({
    id: r.article_id,
    position: r.position,
    title_a: r.title_a ?? r.p_title,
    title_b: r.title_a ? r.title_b ?? "" : "",
    core_a: r.core_a ?? "",
    core_b: r.core_b ?? "",
    summary: r.title_a ? r.c_summary ?? "" : r.p_summary ?? "",
    tag: r.tag ?? "",
    source: (r.title_a && r.source_short) || r.s_name,
    url: r.url,
    score: r.score === null ? null : Number(r.score),
    project: { id: r.project_id, slug: r.slug, target: r.target },
    publishedAt: iso(r.published_at),
    listedAt: iso(r.listed_at)!,
    hasCopy: r.title_a !== null,
    overBudget: r.over_budget === true,
  }));
  return { date: head.issue_date, no: head.issue_no, fixedAt: head.fixed_at.toISOString(), hero: head.hero, ready: items.every((i) => i.hasCopy), items };
}

/** The user's past issues (non-empty), newest first, without the currently displayed day. */
export async function listArchive(userId: string, db: Db = sql, opts: { exclude?: string; limit?: number } = {}): Promise<ArchiveEntry[]> {
  const exclude = opts.exclude ?? "";
  // The exclusion rides as a fragment: an empty exclude must not turn into a date parameter.
  const notShown = exclude ? sql`AND ui.issue_date <> ${exclude}::date` : sql``;
  const rows = await db<{ date: string; no: number; titles: string[] }[]>`
    SELECT to_char(ui.issue_date, 'YYYY-MM-DD') AS date, ui.issue_no AS no,
           (SELECT array_agg(coalesce(c.title_a, p.title) ORDER BY ui2.position)
            FROM user_issue_items ui2
            JOIN publications p ON p.article_id = ui2.article_id
            LEFT JOIN issue_card_copy c ON c.project_id = ui2.project_id AND c.article_id = ui2.article_id
            WHERE ui2.user_id = ui.user_id AND ui2.issue_date = ui.issue_date) AS titles
    FROM user_issues ui
    WHERE ui.user_id = ${userId} AND ui.issue_no IS NOT NULL ${notShown}
    ORDER BY ui.issue_date DESC
    LIMIT ${opts.limit ?? 60}`;
  return rows.map((r) => ({ date: r.date, no: r.no, titles: r.titles }));
}

/** The user's count of non-empty issues (the archive header's 期数). */
export async function issueCount(userId: string, db: Db = sql): Promise<number> {
  return one(await db<{ n: number }[]>`SELECT count(*)::int AS n FROM user_issues WHERE user_id = ${userId} AND issue_no IS NOT NULL`).n;
}

/** The day 今日 shows: today's issue, or the latest earlier one until today's is fixed; null when none. */
export async function shownIssueDate(userId: string, now: Date = new Date(), db: Db = sql): Promise<string | null> {
  const today = currentIssueDateInTz(now, await userTimezone(userId, db));
  const [row] = await db<{ date: string }[]>`
    SELECT to_char(issue_date, 'YYYY-MM-DD') AS date FROM user_issues
    WHERE user_id = ${userId} AND issue_date <= ${today}::date ORDER BY issue_date DESC LIMIT 1`;
  return row?.date ?? null;
}

/** 往期 on both clients: the fixed issues except the one 今日 shows (it is not past yet). */
export async function listPastIssues(userId: string, opts: { now?: Date; db?: Db; limit?: number } = {}): Promise<ArchiveEntry[]> {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  const today = currentIssueDateInTz(now, await userTimezone(userId, db));
  return listArchive(userId, db, { exclude: (await shownIssueDate(userId, now, db)) ?? today, limit: opts.limit });
}

/** A real calendar day as YYYY-MM-DD (2026-02-30 is not). */
export function isIssueDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** The snapshot a client shows: today's (or yesterday's, until today is fixed) issue plus archive. */
export async function buildUserIssue(userId: string, opts: { now?: Date; db?: Db; ensure?: boolean } = {}): Promise<UserIssuePayload> {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  if (opts.ensure !== false) await ensureIssue(userId, { now, db });
  const tz = await userTimezone(userId, db);
  const today = currentIssueDateInTz(now, tz);
  const shown = await shownIssueDate(userId, now, db);
  const issue = shown ? await readIssue(userId, shown, db) : null;
  const opened = issue?.items.length
    ? (await db<{ article_id: string }[]>`
        SELECT r.article_id FROM user_issue_reads r
        JOIN user_issue_items ui ON ui.user_id = r.user_id AND ui.issue_date = ${issue.date} AND ui.article_id = r.article_id
        WHERE r.user_id = ${userId}`).map((r) => r.article_id)
    : [];
  return {
    schemaVersion: ISSUE_SCHEMA_VERSION,
    kind: "user-issue",
    user: { id: userId },
    projects: (await listUserProjects(userId, db)).map(({ id, slug, target }) => ({ id, slug, target })),
    generatedAt: now.toISOString(),
    nextAt: nextIssueAtInTz(now, tz).toISOString(),
    issueCount: await issueCount(userId, db),
    issue,
    opened,
    archive: await listArchive(userId, db, { exclude: issue?.date ?? today }),
    notice: aiNoticeFor(await userLocale(userId, db)),
  };
}

/** Marks one article opened — only when it is in one of the user's issues; idempotent. */
export async function recordOpened(userId: string, articleId: string, opts: { db?: Db; now?: Date } = {}): Promise<boolean> {
  const db = opts.db ?? sql;
  const [inIssue] = await db<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM user_issue_items WHERE user_id = ${userId} AND article_id = ${articleId}) AS ok`;
  if (!inIssue?.ok) return false;
  await db`INSERT INTO user_issue_reads (user_id, article_id) VALUES (${userId}, ${articleId}) ON CONFLICT DO NOTHING`;
  return true;
}

/** The issue's items that still have no card copy — the copy writer's input. */
export async function issueItemsWithoutCopy(userId: string, date: string, db: Db = sql) {
  return db<{
    articleId: string; projectId: string; position: number; title: string; originalTitle: string | null; summary: string | null;
    source: string; url: string; publishedAt: Date; score: number | null;
  }[]>`
    SELECT ui.article_id AS "articleId", ui.project_id AS "projectId", ui.position, p.title, p.original_title AS "originalTitle",
           p.summary, s.name AS source, p.url, p.published_at AS "publishedAt", ui.score
    FROM user_issue_items ui
    JOIN publications p ON p.article_id = ui.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE ui.user_id = ${userId} AND ui.issue_date = ${date}
      AND NOT EXISTS (SELECT 1 FROM issue_card_copy c WHERE c.project_id = ui.project_id AND c.article_id = ui.article_id)
    ORDER BY ui.position`;
}
