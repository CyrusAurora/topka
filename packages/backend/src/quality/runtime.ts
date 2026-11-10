// The evals that read how the running system behaved (docs/quality.md): coverage, freshness and time
// saved, computed from a snapshot exported read-only from a database (scripts/eval-candidates.ts
// --kind runtime → eval/snapshots/runtime.json). Pure functions over the snapshot; ids are anonymised.
import { median, percentile, ratio } from "./metrics.ts";

export interface RuntimeSnapshot {
  since: string;
  until: string;
  sources: Array<{ kind: string; enabled: boolean; health: string; interval: number | null; required: boolean }>;
  /** [source index, started (epoch s), 1 ok / 0 failed / -1 other] */
  runs: Array<[number, number, number]>;
  /** [source group (news / paper / release / x_search…), published (epoch s) | null, discovered (epoch s), backfill 1/0] */
  articles: Array<[string, number | null, number, number]>;
  issues: Array<{ user: string; date: string; no: number | null; fixedAt: number }>;
  items: Array<{ user: string; date: string; position: number; article: string }>;
  reads: Array<{ user: string; article: string; at: number }>;
  marks: Array<{ user: string; article: string; mark: string; at: number }>;
  materials: Array<{ user: string; date: string; n: number }>;
}

/** Fewer observations than this and a number is reported but flagged as too few to rely on. */
export const MIN_SAMPLE = 30;

const DAY = 86_400;

/** 时效性: discovery lag (discovered − published) of every non-backfill article with both times, in minutes. */
export function freshness(s: RuntimeSnapshot) {
  const lags = new Map<string, number[]>();
  const all: number[] = [];
  let skipped = 0;
  for (const [kind, published, discovered, backfill] of s.articles) {
    if (backfill || published === null) { skipped++; continue; }
    const lag = Math.max(0, discovered - published) / 60;
    all.push(lag);
    if (!lags.has(kind)) lags.set(kind, []);
    lags.get(kind)!.push(lag);
  }
  const summary = (xs: number[]) => ({ n: xs.length, p50Minutes: round(percentile(xs, 50)), p90Minutes: round(percentile(xs, 90)), over24h: ratio(xs.filter((x) => x > 24 * 60).length, xs.length), enough: xs.length >= MIN_SAMPLE });
  return { ...summary(all), skipped, byKind: Object.fromEntries([...lags].sort(([a], [b]) => a.localeCompare(b)).map(([k, xs]) => [k, summary(xs)])) };
}

/**
 * 覆盖度: whether the planned fetching happened. Plan completion = successful runs over the runs the
 * interval asks for (each source capped at its plan) for sources enabled now; required gaps = days a
 * source bound to an active project had no successful run; failing = enabled sources whose last three
 * runs all failed.
 */
export function coverage(s: RuntimeSnapshot) {
  const since = Date.parse(s.since) / 1000;
  const until = Date.parse(s.until) / 1000;
  const days = Math.max(1, Math.round((until - since) / DAY));
  const ok = new Map<number, number>();
  const okDays = new Map<number, Set<number>>();
  const last = new Map<number, number[]>();
  for (const [i, at, status] of s.runs) {
    if (status === 1) {
      ok.set(i, (ok.get(i) ?? 0) + 1);
      if (!okDays.has(i)) okDays.set(i, new Set());
      okDays.get(i)!.add(Math.floor((at - since) / DAY));
    }
    if (status !== -1) {
      if (!last.has(i)) last.set(i, []);
      last.get(i)!.push(status);
    }
  }
  let planned = 0, done = 0, requiredDays = 0, gapDays = 0, failing = 0, enabled = 0, required = 0;
  s.sources.forEach((src, i) => {
    if (!src.enabled) return;
    enabled++;
    const expected = src.interval ? Math.floor(((until - since) / 60) / src.interval) : 0;
    planned += expected;
    done += Math.min(expected, ok.get(i) ?? 0);
    const tail = (last.get(i) ?? []).slice(-3);
    if (tail.length === 3 && tail.every((x) => x === 0)) failing++;
    if (src.required) {
      required++;
      requiredDays += days;
      gapDays += days - (okDays.get(i)?.size ?? 0);
    }
  });
  return {
    days,
    enabledSources: enabled,
    planCompletion: ratio(done, planned),
    requiredSources: required,
    requiredGapDays: gapDays,
    requiredGapRate: ratio(gapDays, requiredDays),
    failingSources: failing,
    failingRate: ratio(failing, enabled),
    runs: s.runs.length,
    failedRuns: s.runs.filter((r) => r[2] === 0).length,
  };
}

/**
 * 节省时间: what the issue spares a reader. Updates/materials: an issue's items over the materials its
 * sources brought in that window. Reading time: per issue with reads, first to last opened item.
 * Interviews (how long it took before) cannot come from data; docs/quality.md has the script.
 */
export function timeSaved(s: RuntimeSnapshot) {
  const itemsPer = new Map<string, number>();
  for (const it of s.items) itemsPer.set(`${it.user}|${it.date}`, (itemsPer.get(`${it.user}|${it.date}`) ?? 0) + 1);
  const ratios: number[] = [];
  const materials: number[] = [];
  for (const m of s.materials) {
    const n = itemsPer.get(`${m.user}|${m.date}`) ?? 0;
    if (!n || !m.n) continue;
    ratios.push(n / m.n);
    materials.push(m.n);
  }
  const issueOf = new Map(s.items.map((it) => [`${it.user}|${it.article}`, `${it.user}|${it.date}`]));
  const readsBy = new Map<string, number[]>();
  for (const r of s.reads) {
    const k = issueOf.get(`${r.user}|${r.article}`);
    if (!k) continue;
    if (!readsBy.has(k)) readsBy.set(k, []);
    readsBy.get(k)!.push(r.at);
  }
  const spans = [...readsBy.values()].filter((xs) => xs.length > 1).map((xs) => (Math.max(...xs) - Math.min(...xs)) / 60);
  const nonEmpty = s.issues.filter((i) => i.no !== null).length;
  return {
    issues: s.issues.length,
    nonEmptyIssues: nonEmpty,
    items: s.items.length,
    medianMaterialsPerIssue: median(materials),
    medianUpdateShare: median(ratios) === null ? null : Math.round(median(ratios)! * 10000) / 10000,
    readsLogged: s.reads.length,
    issuesWithReads: readsBy.size,
    medianReadSpanMinutes: round(median(spans)),
    readSpanSamples: spans.length,
    enough: spans.length >= MIN_SAMPLE,
    marks: s.marks.length,
  };
}

function round(x: number | null): number | null {
  return x === null ? null : Math.round(x * 10) / 10;
}
