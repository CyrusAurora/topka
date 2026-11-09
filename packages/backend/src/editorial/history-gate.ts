// History that no reader view shows (backfill items published more than 24 hours ago) is analysed last:
// only in the quiet evening window and only while the day's model quota keeps a reserve for fresh items.
// The reserve is counted against the capacity of every usable provider (Agnes, OpenCode while it still
// offers free models, OpenRouter's remaining requests minus the reserves it keeps for chat), not against
// OpenRouter alone.
//   HISTORY_ANALYSIS        defer (default) | skip (never analysed, marked skipped) | on (no gate)
//   HISTORY_ANALYSIS_WINDOW local hours "20-8" (default; from 20:00 until 08:00, when OpenRouter's UTC day resets)
//   HISTORY_ANALYSIS_TZ     Asia/Shanghai (default, UTC+8)
//   HISTORY_ANALYSIS_RESERVE model calls kept for fresh items (default 150)
//   STALE_ANALYSIS_HOURS    anything published longer ago is skipped, history or not (default 72; 0 = off)
import { sql } from "../db.ts";
import { candidateModels, isBenched, providerOrder } from "../providers/free-chain.ts";
import { openRouterQuota } from "../providers/free-models.ts";
import { BudgetExceededError, interactiveReserve } from "../providers/receipts.ts";

/** Published this long ago, a backfill item never reaches a reader view (projects/today.ts). */
export const READER_HORIZON_MS = 24 * 3_600_000;

export class HistoryDeferredError extends BudgetExceededError {}

export function isUnreadHistory(a: { backfill: boolean; published_at: Date | null; discovered_at: Date }, now = new Date()): boolean {
  if (!a.backfill) return false;
  const at = a.published_at ?? a.discovered_at;
  return now.getTime() - at.getTime() > READER_HORIZON_MS;
}

/**
 * Published more than STALE_ANALYSIS_HOURS ago (default 72; 0 turns it off) when its turn comes: no
 * reader view can show it any more (今日 and its fill reach back 72 hours), so it is skipped without a
 * model call instead of spending the day's free quota on a backlog. An explicit re-evaluation is not gated.
 */
export function staleHours(): number {
  const v = Number(process.env.STALE_ANALYSIS_HOURS ?? 72);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function isStale(a: { published_at: Date | null; discovered_at: Date }, now = new Date()): boolean {
  const hours = staleHours();
  if (!hours) return false;
  return now.getTime() - (a.published_at ?? a.discovered_at).getTime() > hours * 3_600_000;
}

export function historyMode(): "defer" | "skip" | "on" {
  const v = (process.env.HISTORY_ANALYSIS ?? "defer").trim();
  return v === "skip" || v === "on" ? v : "defer";
}

function windowHours(): [number, number] {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec((process.env.HISTORY_ANALYSIS_WINDOW ?? "20-8").trim());
  const from = m ? Number(m[1]) % 24 : 20;
  const to = m ? Number(m[2]) % 24 : 8;
  return [from, to];
}

function localClock(now: Date): { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: process.env.HISTORY_ANALYSIS_TZ || "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: get("hour"), minute: get("minute"), second: get("second") };
}

export function inHistoryWindow(now = new Date()): boolean {
  const [from, to] = windowHours();
  const { hour } = localClock(now);
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Seconds until the window next opens (at least a minute). */
export function secondsToHistoryWindow(now = new Date()): number {
  const [from] = windowHours();
  const { hour, minute, second } = localClock(now);
  let s = ((from - hour + 24) % 24) * 3600 - minute * 60 - second;
  if (s <= 0) s += 24 * 3600;
  return Math.max(60, s);
}

/** The calls a service may still make today: its daily budget minus today's live attempts. null when
 * the service has no budgets row (unlimited). */
export async function serviceLeftToday(service: string): Promise<number | null> {
  const [b] = await sql<{ per_day: number; day_window: string }[]>`SELECT per_day, day_window FROM budgets WHERE service = ${service}`;
  if (!b) return null;
  const utc = b.day_window === "utc";
  const [c] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts WHERE service = ${service} AND origin = 'live' AND started_at > now() - interval '1 day'
      AND (NOT ${utc} OR started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
  return Math.max(0, b.per_day - c!.n);
}

/** Model calls left today: the capacity of every usable provider (Agnes, OpenCode while it still offers
 * free models, OpenRouter's own remaining minus the reserves it keeps for chat). null = unlimited. */
export async function callsLeftToday(): Promise<number | null> {
  const order = providerOrder();
  if (!order.length) return serviceLeftToday("llm"); // no chain, no free guard: the OpenRouter-only path
  let total = 0;
  for (const p of order) {
    if (p === "openrouter") {
      const local = await serviceLeftToday("llm");
      const remote = (await openRouterQuota()).remaining;
      const known = [local, remote].filter((v): v is number => v !== null);
      if (!known.length) return null; // neither limit known: unlimited
      const held = Number(process.env.LLM_FREE_DAILY_RESERVE ?? 20) + interactiveReserve("analyze_article");
      total += Math.max(0, Math.min(...known) - held);
      continue;
    }
    if (isBenched(p)) continue;
    // A route sitting out a rate limit (a minute or two) still has today's capacity; counting it as none
    // would push history to the next evening. Only a benched provider (refusal, billing) counts as gone.
    const models = await candidateModels(p);
    if (!models.length) continue;
    const left = await serviceLeftToday(p);
    if (left === null) return null; // no budgets row: unlimited
    total += left;
  }
  return total;
}

/** Throws HistoryDeferredError (a budget wait: the article waits, never fails) while history must not run. */
export async function assertHistoryMayRun(now = new Date()): Promise<void> {
  if (!inHistoryWindow(now)) throw new HistoryDeferredError("llm", "history deferred until the evening window", secondsToHistoryWindow(now));
  const reserve = Number(process.env.HISTORY_ANALYSIS_RESERVE ?? 150);
  const left = await callsLeftToday();
  if (left !== null && left <= reserve) {
    throw new HistoryDeferredError("llm", `history deferred: ${left} calls left today, ${reserve} kept for fresh items`, secondsToHistoryWindow(now));
  }
}
