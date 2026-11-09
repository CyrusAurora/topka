// Issue timing and the hero rule: an issue is fixed every day at 08:00 UTC+8 (= 00:00 UTC),
// so the issue on display at any moment is that moment's UTC date and the next issue starts at the
// next 00:00 UTC. The hero layout applies only when exactly three items are ready and the top
// item leads the runner-up by at least the configured lead (ISSUE_HERO_LEAD, default 10 points).
export const DEFAULT_HERO_LEAD = 10;

/** Configured hero lead: an integer 0..100, anything else falls back to 10. */
export function heroLead(raw = process.env.ISSUE_HERO_LEAD): number {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : DEFAULT_HERO_LEAD;
}

/** Hero layout: exactly three items and the first leads the second by at least `lead`. */
export function isHero(scores: Array<number | null>, lead = heroLead()): boolean {
  return scores.length === 3 && typeof scores[0] === "number" && typeof scores[1] === "number" && scores[0] - scores[1] >= lead;
}

/** The issue on display at `now`: its UTC date, since 08:00 UTC+8 is 00:00 UTC. */
export function currentIssueDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 08:00 UTC+8 of `date`, the moment the issue is fixed. */
export function issueCutoff(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** The next issue start (00:00 UTC) strictly after `now`. */
export function nextIssueAt(now: Date): Date {
  const next = issueCutoff(currentIssueDate(now));
  return next.getTime() > now.getTime() ? next : new Date(next.getTime() + 24 * 3_600_000);
}

/** UTC+8 calendar date of `d` (no DST), "YYYY-MM-DD". */
export function taipeiDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
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
