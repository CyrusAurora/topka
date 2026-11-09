// Issue timing and the hero rule: an issue is fixed every day at 08:00 local in the user's timezone
// (DEFAULT_TIMEZONE Asia/Shanghai, which preserves the historical UTC-midnight coincidence), so the
// issue on display at any moment is the latest local-08:00 cutoff at or before it, and the next issue
// starts at the following local 08:00. The hero layout applies only when exactly three items are ready
// and the top item leads the runner-up by at least the configured lead (ISSUE_HERO_LEAD, default 10).
export const DEFAULT_HERO_LEAD = 10;
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** Configured hero lead: an integer 0..100, anything else falls back to 10. */
export function heroLead(raw = process.env.ISSUE_HERO_LEAD): number {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : DEFAULT_HERO_LEAD;
}

/** Hero layout: exactly three items and the first leads the second by at least `lead`. */
export function isHero(scores: Array<number | null>, lead = heroLead()): boolean {
  return scores.length === 3 && typeof scores[0] === "number" && typeof scores[1] === "number" && scores[0] - scores[1] >= lead;
}

/** IANA check via Intl. Empty string and junk are rejected. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const partsInTz = (d: Date, tz: string) => {
  const m: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d))
    if (p.type !== "literal") m[p.type] = p.value;
  return m;
};

/** Calendar date of `now` in `tz`, "YYYY-MM-DD". Throws on an invalid zone. */
export function calendarDateInTz(now: Date, tz: string): string {
  const p = partsInTz(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The next calendar date after `date` (civil arithmetic, no zone needed). */
function nextCalendarDate(date: string): string {
  const [y, mo, da] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, da!, 12) + 86_400_000).toISOString().slice(0, 10);
}

/** The instant of local 08:00:00.000 on `date` in `tz`, resolved through Intl so DST is honoured. */
export function issueCutoffInTz(date: string, tz: string): Date {
  const [y, mo, da] = date.split("-").map(Number);
  const target = Date.UTC(y!, mo! - 1, da!, 8, 0, 0);
  let appr = target;
  for (let i = 0; i < 3; i++) {
    const p = partsInTz(new Date(appr), tz);
    const localAsUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
    appr -= localAsUtc - target;
  }
  return new Date(appr);
}

/** The issue on display at `now` in `tz`: the latest date whose local-08:00 cutoff is at or before `now`. */
export function currentIssueDateInTz(now: Date, tz: string): string {
  const today = calendarDateInTz(now, tz);
  const todayCutoff = issueCutoffInTz(today, tz).getTime();
  if (todayCutoff <= now.getTime()) return today;
  // Before today's 08:00 local: the issue on display is the previous calendar day (civil, not a 1ms step).
  return prevCalendarDate(today);
}

/** The previous calendar date before `date`. */
function prevCalendarDate(date: string): string {
  const [y, mo, da] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, da!, 12) - 86_400_000).toISOString().slice(0, 10);
}

/** The next local-08:00 cutoff strictly after `now` in `tz`. */
export function nextIssueAtInTz(now: Date, tz: string): Date {
  const today = calendarDateInTz(now, tz);
  const todayCutoff = issueCutoffInTz(today, tz);
  if (todayCutoff.getTime() > now.getTime()) return todayCutoff;
  let out = issueCutoffInTz(nextCalendarDate(today), tz);
  // On a fall-back day the calendar step can still land at or before now in ambiguous hours; walk forward.
  for (let i = 0; i < 3 && out.getTime() <= now.getTime(); i++) {
    out = issueCutoffInTz(nextCalendarDate(calendarDateInTz(out, tz)), tz);
  }
  return out;
}

/** The issue on display at `now`: its UTC date, since 08:00 UTC+8 is 00:00 UTC. */
export function currentIssueDate(now: Date): string {
  return currentIssueDateInTz(now, DEFAULT_TIMEZONE);
}

/** 08:00 local of `date` in Asia/Shanghai (08:00 UTC+8 = 00:00 UTC). */
export function issueCutoff(date: string): Date {
  return issueCutoffInTz(date, DEFAULT_TIMEZONE);
}

/** The next issue start (00:00 UTC) strictly after `now`. */
export function nextIssueAt(now: Date): Date {
  return nextIssueAtInTz(now, DEFAULT_TIMEZONE);
}

/** UTC+8 calendar date of `d` (no DST), "YYYY-MM-DD". */
export function taipeiDate(d: Date): string {
  return calendarDateInTz(d, "Asia/Taipei");
}

/**
 * At most this many of an issue's cards from one source. Paper feeds score systematically higher
 * than industry news, so pure score order let one source take all three cards (October: 18 of 23,
 * six of eight days arXiv cs.RO alone). Two keeps the best source on top but leaves one slot for
 * another source; a constant, since no deployment has a reason to tune it.
 */
export const MAX_PER_SOURCE = 2;

/**
 * Picks up to `size` cards from `ranked` (already in score order, already above the floor), skipping
 * any candidate whose source already has MAX_PER_SOURCE cards among `taken` plus the picks so far.
 * Order is kept, so the leading card is always the best candidate and ties stay as the SQL broke them.
 * Fewer than `size` when there are not enough sources: fewer cards, never filler.
 */
export function capPerSource<T>(ranked: readonly T[], size: number, sourceOf: (t: T) => string, taken: readonly T[] = []): T[] {
  const count = new Map<string, number>();
  for (const t of taken) count.set(sourceOf(t), (count.get(sourceOf(t)) ?? 0) + 1);
  const picked: T[] = [];
  for (const c of ranked) {
    if (taken.length + picked.length >= size) break;
    const n = count.get(sourceOf(c)) ?? 0;
    if (n >= MAX_PER_SOURCE) continue;
    count.set(sourceOf(c), n + 1);
    picked.push(c);
  }
  return picked;
}
