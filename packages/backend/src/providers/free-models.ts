// Free-only model guard. With LLM_FREE_MODELS (OpenRouter) or EMBEDDING_FREE_MODELS (SiliconFlow) set,
// a call only goes to a candidate whose published price is zero right now. Free lists change: each
// candidate is re-verified from the provider's own catalog (cached for an hour, refreshed at worker
// start), and when no candidate qualifies the calls pause (NoFreeModelError: work waits, never fails,
// and never falls back to a paid model).
import { credential } from "../config.ts";
import { BudgetExceededError, interactiveReserve, secondsToUtcMidnight } from "./receipts.ts";

export type FreeKind = "llm" | "embedding";

/** A BudgetExceededError, so every caller already treats it as "wait and retry", not as a failure. */
export class NoFreeModelError extends BudgetExceededError {
  readonly kind: FreeKind;
  constructor(kind: FreeKind, retryAfterSeconds: number, detail: string) {
    super(kind === "llm" ? "llm" : "embedding", kind === "llm" ? `NO_FREE_MODEL: ${detail}` : `NO_FREE_EMBEDDING: ${detail}`, retryAfterSeconds);
    this.kind = kind;
  }
}

export interface CandidateCheck { id: string; free: boolean; reason: string }
export interface FreeStatus { kind: FreeKind; checkedAt: number; ok: boolean; candidates: CandidateCheck[]; error?: string }

const CACHE_MS = 60 * 60_000;
/** A catalog that could not be read is retried sooner; meanwhile nothing counts as verified. */
const FAILED_CACHE_MS = 5 * 60_000;
const ZERO = /^0(\.0+)?$/;

function list(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
}

export function freeCandidates(kind: FreeKind): string[] {
  return list(kind === "llm" ? process.env.LLM_FREE_MODELS : process.env.EMBEDDING_FREE_MODELS);
}

/** On when a candidate list is configured; the list then replaces LLM_MODEL / EMBEDDING_MODEL. */
export function freeGuardOn(kind: FreeKind): boolean {
  return freeCandidates(kind).length > 0;
}

/** Ids that can never be "one free model": routers, auto-pickers and anything without a :free variant. */
export function routerOrUnpinned(id: string): string | null {
  if (/^openrouter\//i.test(id) || /(^|\/)auto$/i.test(id)) return "router/auto ids may route to paid models";
  if (!id.endsWith(":free")) return "not a :free variant id";
  return null;
}

/** OpenRouter: every pricing field present must be the string "0" (prompt and completion at least). */
export function openRouterPriceCheck(id: string, catalog: unknown): CandidateCheck {
  const unpinned = routerOrUnpinned(id);
  if (unpinned) return { id, free: false, reason: unpinned };
  const data = (catalog as { data?: Array<{ id?: string; pricing?: Record<string, unknown> }> })?.data;
  if (!Array.isArray(data)) return { id, free: false, reason: "catalog unreadable" };
  const entry = data.find((m) => m.id === id);
  if (!entry) return { id, free: false, reason: "not in the catalog" };
  const pricing = entry.pricing;
  if (!pricing || typeof pricing !== "object") return { id, free: false, reason: "no pricing" };
  if (!("prompt" in pricing) || !("completion" in pricing)) return { id, free: false, reason: "pricing lacks prompt/completion" };
  const paid = Object.entries(pricing).filter(([, v]) => !(typeof v === "string" && ZERO.test(v.trim())));
  if (paid.length) return { id, free: false, reason: `priced: ${paid.map(([k, v]) => `${k}=${String(v)}`).join(", ")}` };
  return { id, free: true, reason: `all ${Object.keys(pricing).length} pricing fields are "0"` };
}

/** The Next.js flight data of siliconflow.cn/pricing, as `id -> value` (the page embeds its price table). */
export function siliconFlowFlight(html: string): Map<string, unknown> {
  let stream = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      stream += JSON.parse(m[1]!) as string;
    } catch {
      /* a chunk that is not a string literal */
    }
  }
  const rows = new Map<string, unknown>();
  for (const line of stream.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0 || !/^[0-9a-f]+$/i.test(line.slice(0, colon))) continue;
    try {
      rows.set(line.slice(0, colon), JSON.parse(line.slice(colon + 1)));
    } catch {
      /* text rows and the like */
    }
  }
  return rows;
}

function deref(rows: Map<string, unknown>, value: unknown): unknown {
  return typeof value === "string" && /^\$[0-9a-f]+$/i.test(value) ? rows.get(value.slice(1)) : value;
}

/** SiliconFlow: the model's list price and every per-item price must be "0", and it must be live. */
export function siliconFlowPriceCheck(id: string, rows: Map<string, unknown>): CandidateCheck {
  if (/^Pro\//.test(id)) return { id, free: false, reason: "Pro/ models are billed" };
  const entries = [...rows.values()].filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && (v as { modelName?: unknown }).modelName === id);
  if (!entries.length) return { id, free: false, reason: "not on the pricing page" };
  for (const e of entries) {
    if (e.status !== undefined && e.status !== "normal") return { id, free: false, reason: `status ${String(e.status)}` };
    if (!(typeof e.price === "string" && ZERO.test(e.price))) return { id, free: false, reason: `price ${String(e.price)}` };
    const pricing = deref(rows, e.pricing);
    if (!Array.isArray(pricing) || !pricing.length) return { id, free: false, reason: "price breakdown unreadable" };
    for (const p of pricing.map((x) => deref(rows, x)) as Array<{ price?: unknown; specification?: unknown }>) {
      if (!(typeof p?.price === "string" && ZERO.test(p.price))) return { id, free: false, reason: `priced: ${String(p?.specification)}=${String(p?.price)}` };
    }
  }
  return { id, free: true, reason: "list price and every price item are 0" };
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return text;
}

async function verify(kind: FreeKind): Promise<FreeStatus> {
  const ids = freeCandidates(kind);
  const checkedAt = Date.now();
  try {
    if (kind === "llm") {
      const base = (credential("models", "LLM_BASE_URL") ?? "").replace(/\/$/, "");
      if (!/openrouter\.ai/.test(base) && !process.env.LLM_FREE_CATALOG_URL) throw new Error("LLM_FREE_MODELS needs LLM_BASE_URL on OpenRouter");
      const catalog = JSON.parse(await fetchText(process.env.LLM_FREE_CATALOG_URL || `${base}/models`));
      const candidates = ids.map((id) => openRouterPriceCheck(id, catalog));
      return { kind, checkedAt, ok: candidates.some((c) => c.free), candidates };
    }
    const rows = siliconFlowFlight(await fetchText(process.env.EMBEDDING_FREE_PRICING_URL || "https://siliconflow.cn/pricing"));
    // The account's own model list confirms the key can reach the model.
    const base = (credential("models", "EMBEDDING_BASE_URL") ?? "").replace(/\/$/, "");
    const key = credential("models", "EMBEDDING_API_KEY");
    const listed = new Set<string>();
    if (base && key) {
      const models = JSON.parse(await fetchText(`${base}/models?sub_type=embedding`, { authorization: `Bearer ${key}` })) as { data?: Array<{ id: string }> };
      for (const m of models.data ?? []) listed.add(m.id);
    }
    const candidates = ids.map((id) => {
      const c = siliconFlowPriceCheck(id, rows);
      return c.free && !listed.has(id) ? { id, free: false, reason: "not offered to this key" } : c;
    });
    return { kind, checkedAt, ok: candidates.some((c) => c.free), candidates };
  } catch (error) {
    return { kind, checkedAt, ok: false, candidates: ids.map((id) => ({ id, free: false, reason: "unverified" })), error: String((error as Error).message ?? error).slice(0, 300) };
  }
}

const cache = new Map<FreeKind, { status: FreeStatus; expires: number; pending?: Promise<FreeStatus> }>();
/** Candidates that misbehaved (rate-limited, billed, answered as another model) sit out for a while. */
const benched = new Map<string, { until: number; reason: string }>();

export async function freeStatus(kind: FreeKind, opts: { refresh?: boolean } = {}): Promise<FreeStatus> {
  const hit = cache.get(kind);
  if (!opts.refresh && hit && hit.expires > Date.now()) return hit.status;
  if (hit?.pending) return hit.pending;
  const pending = verify(kind).then((status) => {
    cache.set(kind, { status, expires: Date.now() + (status.error ? FAILED_CACHE_MS : CACHE_MS) });
    if (!status.ok) console.error(JSON.stringify({ level: "warn", msg: kind === "llm" ? "NO_FREE_MODEL" : "NO_FREE_EMBEDDING", status }));
    return status;
  });
  cache.set(kind, { status: hit?.status ?? { kind, checkedAt: 0, ok: false, candidates: [] }, expires: 0, pending });
  return pending;
}

export function benchModel(kind: FreeKind, id: string, seconds: number, reason: string) {
  benched.set(`${kind}:${id}`, { until: Date.now() + seconds * 1000, reason });
  console.error(JSON.stringify({ level: "warn", msg: "free model benched", kind, model: id, seconds, reason }));
}

/** Unusable answers in a row per candidate (no JSON, wrong shape); a usable answer resets it. */
const unusable = new Map<string, number>();
export const UNUSABLE_STREAK = 2;
export const UNUSABLE_BENCH_SECONDS = 30 * 60;

/** A candidate that keeps answering junk (some free models cannot keep to JSON) sits out for half an
 * hour after UNUSABLE_STREAK in a row, so the work waits for a model that can answer instead of
 * spending every article's attempts on it. */
export function noteUnusable(kind: FreeKind, id: string): void {
  const n = (unusable.get(`${kind}:${id}`) ?? 0) + 1;
  unusable.set(`${kind}:${id}`, n);
  if (n >= UNUSABLE_STREAK) {
    unusable.delete(`${kind}:${id}`);
    benchModel(kind, id, UNUSABLE_BENCH_SECONDS, `unusable output ${n} times in a row`);
  }
}

/** 429s in a row per candidate; a usable answer resets it. */
const limited = new Map<string, number>();
export const RATE_LIMIT_MAX_SECONDS = 30 * 60;

/** A rate-limited candidate sits out 60 s, then twice as long on each further 429 in a row (up to
 * 30 min), so an upstream that keeps refusing is not hammered every minute (on 10-30 from 08:00
 * Taipei, 171 of 351 requests were upstream 429s). OpenRouter's own free-request counter does not
 * count those refusals; the local day budget leaves them out too (receipts.ts checkBudget). Bench
 * expiry is wall-clock (Date.now()), so time the host spends suspended counts towards it. */
export function noteRateLimited(kind: FreeKind, id: string, retryAfter?: number): number {
  const n = (limited.get(`${kind}:${id}`) ?? 0) + 1;
  limited.set(`${kind}:${id}`, n);
  const seconds = Math.min(RATE_LIMIT_MAX_SECONDS, Math.max(retryAfter ?? 0, 60 * 2 ** (n - 1)));
  benchModel(kind, id, seconds, n > 1 ? `HTTP 429 (${n} in a row)` : "HTTP 429");
  return seconds;
}

export function noteUsable(kind: FreeKind, id: string): void {
  unusable.delete(`${kind}:${id}`);
  limited.delete(`${kind}:${id}`);
}

/** True when some verified-free candidate is sitting out right now (rate limit, junk, billing). */
export async function someBenched(kind: FreeKind): Promise<boolean> {
  const status = await freeStatus(kind);
  const now = Date.now();
  return status.candidates.some((c) => c.free && (benched.get(`${kind}:${c.id}`)?.until ?? 0) > now);
}

/** The first verified-free candidate that is not benched (nor in `skip`, the ones this call already
 * tried); NoFreeModelError when there is none. */
export async function pickFreeModel(kind: FreeKind, skip?: ReadonlySet<string>): Promise<string> {
  const status = await freeStatus(kind);
  const now = Date.now();
  let soonest = Infinity;
  for (const c of status.candidates) {
    if (!c.free || skip?.has(c.id)) continue;
    const b = benched.get(`${kind}:${c.id}`);
    if (b && b.until > now) {
      soonest = Math.min(soonest, b.until);
      continue;
    }
    return c.id;
  }
  const wait = Number.isFinite(soonest) ? Math.max(30, Math.ceil((soonest - now) / 1000)) : status.error ? 300 : 3600;
  const detail = status.error ?? (status.candidates.some((c) => c.free) ? "all free candidates are cooling down" : "no candidate is free");
  throw new NoFreeModelError(kind, wait, detail);
}

/** Checks a response after the fact: it must name the model asked for and cost nothing. */
export function auditFreeResponse(kind: FreeKind, requested: string, response: { model?: unknown; usage?: { cost?: unknown } | null }): string | null {
  const used = typeof response.model === "string" ? response.model : null;
  const cost = response.usage?.cost;
  if (used && used !== requested) return `answered by ${used}, not ${requested}`;
  if (cost !== undefined && cost !== null && Number(cost) !== 0) return `usage.cost ${String(cost)} != 0`;
  return null;
}

/**
 * OpenRouter's own count of today's free-model requests (GET /key, cached a minute): the authoritative
 * guard next to the local budget. At or below LLM_FREE_DAILY_RESERVE remaining (default 20, a minute
 * of calls at 18/min) calls wait for 00:00 UTC. A failed lookup leaves the local budget in charge.
 */
let quota: { at: number; remaining: number | null; limit: number | null; used: number | null } | null = null;
const QUOTA_CACHE_MS = 60_000;

export async function openRouterQuota(): Promise<{ remaining: number | null; limit: number | null; used: number | null }> {
  if (quota && Date.now() - quota.at < QUOTA_CACHE_MS) return quota;
  const base = (credential("models", "LLM_BASE_URL") ?? "").replace(/\/$/, "");
  const url = process.env.LLM_FREE_QUOTA_URL || (/openrouter\.ai/.test(base) ? `${base}/key` : "");
  const key = credential("models", "LLM_API_KEY");
  let next = { at: Date.now(), remaining: null as number | null, limit: null as number | null, used: null as number | null };
  if (url && key) {
    try {
      const j = JSON.parse(await fetchText(url, { authorization: `Bearer ${key}` })) as { data?: { free_model_daily_requests?: { remaining?: unknown; limit?: unknown; used?: unknown } } };
      const f = j.data?.free_model_daily_requests;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      if (f) next = { at: Date.now(), remaining: num(f.remaining), limit: num(f.limit), used: num(f.used) };
    } catch {
      /* the local budget still counts */
    }
  }
  quota = next;
  return quota;
}

export async function assertOpenRouterQuota(purpose?: string): Promise<void> {
  const reserve = Number(process.env.LLM_FREE_DAILY_RESERVE ?? 20) + interactiveReserve(purpose);
  const q = await openRouterQuota();
  if (q.remaining !== null && q.remaining <= reserve) {
    throw new BudgetExceededError("llm", `OpenRouter free requests today: ${q.remaining} left of ${q.limit ?? "?"}`, secondsToUtcMidnight());
  }
}

export function resetFreeGuard() {
  cache.clear();
  benched.clear();
  unusable.clear();
  limited.clear();
  quota = null;
}
