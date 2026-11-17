// The per-project today view (master design J4; the checkpoint in its first, simple form of 3.3):
// a fixed number of cards (TODAY_CARD_COUNT, 3–5, default 3) from the published items of the project's
// linked sources that entered the pool since the reader last confirmed, ordered by the project score
// (project-score.ts), one card per event (grouped stories never take two slots). There is no floor and
// no overflow list: the rest is not important. A day whose cards average below QUIET_DAY_MEAN is
// flagged quiet, so a reader can be told the day was quiet. Reading never moves the checkpoint; only acknowledgeToday does,
// and only forward. Nothing qualifying is a first-class result ("无重要变化"), never an error.
// The same payload is what the snapshot export writes.
//
// The checkpoint follows master design 3.3 (D12, the 010 semantics): every payload is an immutable
// snapshot (project_brief_snapshots, content-addressed id) with a top result from the decision table
// in @topka/contracts/brief (snapshot failed → partial coverage → importance not assessed → updates →
// no important change; offline or signed out is the client's own first row). Only the last two may be
// confirmed; a confirmation names the snapshot, the ackSeq it was built on, the cards it showed and a
// commandId, runs the rejection checks in the documented order, and returns a receipt (the same
// command always the same one). Withdrawn observations are no current evidence and never enter.
import { createHash } from "node:crypto";
import { instanceSetup } from "./instance-setup.ts";
import { sql, type Db } from "../db.ts";
import type { OwnedProject } from "../publication/project-owner.ts";
import { ledgerStates, type LedgerView } from "../content/withdrawals.ts";
import {
  acknowledgementAllowed, coverageSatisfied, decideAck, evaluateBrief,
  type AckRejection, type BriefResult, type CoverageEntry, type CoverageStatus,
} from "@topka/contracts/brief";

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
/** The empty state names the same window as the page's source line (trial 2026-11-10: 「最近 24 小时」 above 「自上次阅读以来」). */
export function noChangeDetail(basis: "checkpoint" | "default" | "capped"): string {
  if (basis === "checkpoint") return NO_CHANGE_DETAIL;
  return `${basis === "capped" ? "最近 7 天里" : "最近 24 小时里"}，关注的来源没有达到重要更新条件的新内容。这不表示什么都没发生。`;
}
export const TODAY_NOTICE = "全部内容仅为发布方声明、未独立核验；中文标题和摘要由模型生成，是分析，不是证据，以原文为准。";

/** The server's results: every row of the table except the client-only offline-or-auth. */
export type TodayResult = Exclude<BriefResult, "offline-or-auth">;

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
  /** current or corrected (a withdrawn observation is never a card). */
  ledger: LedgerView["state"];
  revision: number;
}

export interface TodayPayload {
  schemaVersion: number;
  kind: "project-today";
  project: { id: string; slug: string; target: string; purpose: string };
  generatedAt: string;
  /** Left-open, right-closed: listedAt > since and <= until. `until` is what an acknowledgement sends back. */
  window: { since: string; until: string; basis: "checkpoint" | "default" | "capped" };
  checkpoint: { readThrough: string | null; ackSeq: number; receiptId: string | null };
  /** What a confirmation names; id null when the snapshot could not be stored (snapshot-failed). */
  snapshot: { id: string | null; ackSeq: number; acknowledgementAllowed: boolean };
  /**
   * linked: bound to the project; active: switched on and not paused; scheduled: the active ones the
   * worker fetches (not `external`); collectionOn: COLLECT_ENABLED; analysisOn: a real model analyses
   * new articles. The page explains a gap between them.
   */
  sources: { linked: number; active: number; scheduled: number; collectionOn: boolean; analysisOn: boolean };
  /** The coverage certificate: satisfied when every required source was checked recently. */
  coverage: { satisfied: boolean; sources: CoverageEntry[] };
  /** Collected from the linked sources in the window but not assessed yet. */
  unassessed: number;
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
  return (await readCheckpointRow(userId, projectId, db)).readThrough;
}

interface CheckpointRow { readThrough: Date | null; ackSeq: number; snapshotId: string | null; receiptId: string | null }

async function readCheckpointRow(userId: string, projectId: string, db: Db, lock = false): Promise<CheckpointRow> {
  const [row] = await db<{ read_through: Date | null; ack_seq: number; snapshot_id: string | null; receipt_id: string | null }[]>`
    SELECT read_through, ack_seq, snapshot_id, receipt_id FROM project_read_checkpoints
    WHERE user_id = ${userId} AND project_id = ${projectId} ${lock ? db`FOR UPDATE` : db``}`;
  return { readThrough: row?.read_through ?? null, ackSeq: Number(row?.ack_seq ?? 0), snapshotId: row?.snapshot_id ?? null, receiptId: row?.receipt_id ?? null };
}

/** A source counts as checked when its last successful check is within two intervals (at least an hour). */
export function coverageStatus(s: { paused: boolean; enabled: boolean; health: string; lastOkAt: Date | null; intervalMinutes: number }, now: Date): CoverageStatus {
  if (s.paused || !s.enabled) return "paused";
  if (!s.lastOkAt) return "never-checked";
  if (s.health === "failing") return "failing";
  const fresh = Math.max(2 * s.intervalMinutes, 60) * 60_000;
  return now.getTime() - s.lastOkAt.getTime() > fresh ? "stale" : "checked";
}

export async function projectCoverage(projectId: string, now: Date, db: Db = sql): Promise<CoverageEntry[]> {
  const rows = await db<{ source_id: string; name: string; required: boolean; paused: boolean; enabled: boolean; health: string; last_ok_at: Date | null; interval_minutes: number }[]>`
    SELECT ps.source_id, s.name, ps.required, ps.paused, s.enabled, s.health, s.last_ok_at, s.interval_minutes
    FROM project_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.project_id = ${projectId}
    ORDER BY ps.required DESC, s.name, s.id`;
  return rows.map((r) => {
    const status = coverageStatus({ paused: r.paused, enabled: r.enabled, health: r.health, lastOkAt: r.last_ok_at, intervalMinutes: r.interval_minutes }, now);
    // checkedAtUtc is the last successful check; a source that never had one has none.
    return { sourceId: r.source_id, name: r.name, required: r.required, status, checkedAtUtc: iso(r.last_ok_at) };
  });
}

/** brief-snapshot-v1: + the first 32 hex digits of the SHA-256 of the snapshot's content. */
export function snapshotIdFor(content: unknown): string {
  return `brief-snapshot-v1:${createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 32)}`;
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
  const cp = await readCheckpointRow(userId, project.id, db);
  const checkpoint = cp.readThrough;
  // Left-open, right-closed: (since, until]. Anything entering after `until` belongs to the next window.
  const until = now;
  const floor = new Date(now.getTime() - MAX_WINDOW_DAYS * 86_400_000);
  let since: Date;
  let basis: TodayPayload["window"]["basis"];
  if (!checkpoint) [since, basis] = [new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000), "default"];
  else if (checkpoint < floor) [since, basis] = [floor, "capped"];
  else [since, basis] = [checkpoint, "checkpoint"];

  const [counts] = await db<{ linked: number; active: number; scheduled: number }[]>`
    SELECT count(*)::int AS linked, count(*) FILTER (WHERE s.enabled AND NOT ps.paused)::int AS active,
           count(*) FILTER (WHERE s.enabled AND NOT ps.paused AND s.kind <> 'external')::int AS scheduled
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
      WHERE p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${until})
        -- A withdrawn observation is no current evidence (its record stays readable).
        AND NOT EXISTS (SELECT 1 FROM article_withdrawal_state w WHERE w.article_id = p.article_id AND w.withdrawn)
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
      WHERE x.entered_at > ${since} AND x.entered_at <= ${until}
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
  const ledger = await ledgerStates(rows.map((r) => r.id), db);
  const items: TodayItem[] = rows.map((r) => {
    const generic = r.generic === null ? null : Number(r.generic);
    const score = r.project_score ?? generic;
    return {
      id: r.id, title: r.title, originalTitle: r.original_title && r.original_title !== r.title ? r.original_title : null, summary: r.summary,
      url: r.url, source: { id: r.source_id, name: r.source_name }, publishedAt: iso(r.published_at), listedAt: iso(r.listed_at)!,
      selected: r.selected, score, scoreBasis: r.project_score !== null ? "project" : generic !== null ? "generic" : null, genericScore: generic, storyId: r.story,
      ledger: ledger.get(r.id)?.state ?? "current", revision: ledger.get(r.id)?.revision ?? 1,
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
    WHERE p.article_id IS NULL AND a.processing_state = 'new' AND a.created_at > ${since} AND a.created_at <= ${until}
      -- Only what could become a card: history never does, a first import only when recent.
      AND (NOT a.backfill OR (a.backfill_reason = 'first-import' AND a.published_at > ${new Date(now.getTime() - RECENT_IMPORT_HOURS * 3_600_000)}))
      AND NOT EXISTS (SELECT 1 FROM article_withdrawal_state w WHERE w.article_id = a.id AND w.withdrawn)`;
  const unassessed = pending?.n ?? 0;
  const coverage = await projectCoverage(project.id, now, db);
  const satisfied = coverageSatisfied(coverage);

  const conditions = { offlineOrAuth: false, snapshotFailed: false, coverageSatisfied: satisfied, unassessed, updates: items.length };
  let result = evaluateBrief(conditions) as TodayResult;
  // The snapshot: what this reader was shown, stored before it is shown. Same content, same id.
  const content = {
    userId, projectId: project.id, revision: project.currentRevision, ackSeq: cp.ackSeq, since: since.toISOString(), until: until.toISOString(), basis,
    coverage, itemIds: items.map((i) => i.id), unassessed, result,
  };
  let snapshotId: string | null = snapshotIdFor(content);
  try {
    await db`
      INSERT INTO project_brief_snapshots (snapshot_id, user_id, project_id, revision, ack_seq, window_since, window_until, basis, coverage, item_ids,
        unassessed, top_result, acknowledgement_allowed)
      VALUES (${snapshotId}, ${userId}, ${project.id}, ${project.currentRevision}, ${cp.ackSeq}, ${since}, ${until}, ${basis}, ${db.json(coverage as never)},
        ${content.itemIds}, ${unassessed}, ${result}, ${acknowledgementAllowed(result)})
      ON CONFLICT (snapshot_id) DO NOTHING`;
  } catch (error) {
    // Nothing to confirm against: the brief is still shown, read-only.
    console.error(`brief snapshot for ${project.id} not stored: ${error instanceof Error ? error.message : String(error)}`);
    snapshotId = null;
    result = evaluateBrief({ ...conditions, snapshotFailed: true }) as TodayResult;
  }
  return {
    schemaVersion: TODAY_SCHEMA_VERSION,
    kind: "project-today",
    project: { id: project.id, slug: project.slug, target: project.target, purpose: project.purpose },
    generatedAt: now.toISOString(),
    window: { since: since.toISOString(), until: until.toISOString(), basis },
    checkpoint: { readThrough: iso(checkpoint), ackSeq: cp.ackSeq, receiptId: cp.receiptId },
    snapshot: { id: snapshotId, ackSeq: cp.ackSeq, acknowledgementAllowed: acknowledgementAllowed(result) },
    sources: { linked: counts?.linked ?? 0, active: counts?.active ?? 0, scheduled: counts?.scheduled ?? 0, ...instanceSetup() },
    coverage: { satisfied, sources: coverage },
    unassessed,
    result,
    emptyState: result === "no-important-change" ? { title: NO_CHANGE_TITLE, detail: noChangeDetail(basis) } : null,
    items,
    cardCount: limit,
    candidates,
    quietDay: cardsMean === null || cardsMean < QUIET_DAY_MEAN,
    cardsMean,
    awaitingAnalysis: unassessed,
    notice: TODAY_NOTICE,
  };
}

/** Why a confirmation was refused: a rule of the table, or a request that names no stored snapshot. */
export type AckReason = AckRejection | "snapshot-required" | "unknown-snapshot" | "invalid-through" | "future-through";

export class AckRejected extends Error {
  readonly reason: AckReason;
  constructor(reason: AckReason) {
    super(reason);
    this.reason = reason;
  }
}

export interface AckInput {
  snapshotId: string;
  ackSeq: number;
  shownIds: string[];
  commandId: string;
}

export interface AckResult {
  receiptId: string;
  ackSeq: number;
  readThrough: string;
  snapshotId: string;
  /** The same confirmation again: nothing moved, the stored receipt. */
  idempotent: boolean;
  /** Kept for older clients: the checkpoint moved. */
  advanced: boolean;
}

/**
 * "看完了": the reader confirms the snapshot they were shown. The checks run in the order of 3.3
 * (decideAck), inside one transaction holding the checkpoint row; on success the checkpoint moves to
 * the snapshot's window end with ackSeq + 1, and the confirmation is logged. Any failure leaves the
 * checkpoint where it was. Reading, marking, switching the language never come here.
 */
export async function acknowledgeToday(userId: string, project: OwnedProject, input: AckInput, opts: { db?: typeof sql } = {}): Promise<AckResult> {
  if (!input.snapshotId) throw new AckRejected("snapshot-required");
  const db = opts.db ?? sql;
  return db.begin(async (tx) => {
    await tx`INSERT INTO project_read_checkpoints (user_id, project_id) VALUES (${userId}, ${project.id}) ON CONFLICT DO NOTHING`;
    const cp = await readCheckpointRow(userId, project.id, tx, true);
    const [snap] = await tx<{ snapshot_id: string; project_id: string; revision: number; ack_seq: number; acknowledgement_allowed: boolean; window_until: Date; item_ids: string[] }[]>`
      SELECT snapshot_id, project_id, revision, ack_seq, acknowledgement_allowed, window_until, item_ids
      FROM project_brief_snapshots WHERE snapshot_id = ${input.snapshotId} AND user_id = ${userId}`;
    if (!snap) throw new AckRejected("unknown-snapshot");
    const commandId = input.commandId.trim();
    // The same command for the same snapshot, at any time later: its receipt again.
    if (commandId) {
      const [prior] = await tx<{ snapshot_id: string; receipt_id: string; ack_seq: number; read_through: Date }[]>`
        SELECT snapshot_id, receipt_id, ack_seq, read_through FROM project_checkpoint_acks
        WHERE user_id = ${userId} AND project_id = ${project.id} AND command_id = ${commandId}`;
      if (prior && prior.snapshot_id === snap.snapshot_id && snap.project_id === project.id) {
        return { receiptId: prior.receipt_id, ackSeq: Number(prior.ack_seq), readThrough: prior.read_through.toISOString(), snapshotId: prior.snapshot_id, idempotent: true, advanced: false };
      }
      if (prior) throw new AckRejected("command-required");
    }
    const decision = decideAck(
      { snapshotId: snap.snapshot_id, projectId: snap.project_id, revision: snap.revision, ackSeq: Number(snap.ack_seq), acknowledgementAllowed: snap.acknowledgement_allowed, until: snap.window_until.toISOString(), itemIds: snap.item_ids },
      { ackSeq: cp.ackSeq, snapshotId: cp.snapshotId, readThrough: iso(cp.readThrough), receiptId: cp.receiptId },
      { projectId: project.id, currentRevision: project.currentRevision, ackSeq: Number(input.ackSeq), shownIds: input.shownIds, commandId },
    );
    if (decision.kind === "reject") throw new AckRejected(decision.reason);
    if (decision.kind === "idempotent") {
      return { receiptId: decision.receiptId, ackSeq: cp.ackSeq, readThrough: iso(cp.readThrough)!, snapshotId: snap.snapshot_id, idempotent: true, advanced: false };
    }
    const ackSeq = cp.ackSeq + 1;
    await tx`
      UPDATE project_read_checkpoints SET ack_seq = ${ackSeq}, read_through = ${snap.window_until}, snapshot_id = ${snap.snapshot_id},
        receipt_id = ${decision.receiptId}, command_id = ${commandId}, revision = ${snap.revision}, acks = acks + 1, updated_at = now()
      WHERE user_id = ${userId} AND project_id = ${project.id}`;
    await tx`
      INSERT INTO project_checkpoint_acks (user_id, project_id, ack_seq, snapshot_id, command_id, receipt_id, read_through)
      VALUES (${userId}, ${project.id}, ${ackSeq}, ${snap.snapshot_id}, ${commandId}, ${decision.receiptId}, ${snap.window_until})`;
    return { receiptId: decision.receiptId, ackSeq, readThrough: snap.window_until.toISOString(), snapshotId: snap.snapshot_id, idempotent: false, advanced: true };
  });
}
