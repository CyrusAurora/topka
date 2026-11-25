// Small, shared arithmetic for the quality evals (docs/quality.md). Every eval reports its own
// dimension's numbers; nothing here combines dimensions into one score.

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export const emptyConfusion = (): Confusion => ({ tp: 0, fp: 0, fn: 0, tn: 0 });

export function addOutcome(c: Confusion, predicted: boolean, actual: boolean): Confusion {
  if (predicted && actual) c.tp++;
  else if (predicted) c.fp++;
  else if (actual) c.fn++;
  else c.tn++;
  return c;
}

/** A ratio rounded to three places; null when the denominator is 0 (no evidence either way). */
export function ratio(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 1000) / 1000 : null;
}

export function precisionRecall(c: Confusion) {
  return {
    ...c,
    precision: ratio(c.tp, c.tp + c.fp),
    recall: ratio(c.tp, c.tp + c.fn),
    accuracy: ratio(c.tp + c.tn, c.tp + c.fp + c.fn + c.tn),
  };
}

/** Nearest-rank percentile of `values` (p in 0..100); null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Groups items by a key, keeping first-seen order. */
export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(it);
  }
  return out;
}
