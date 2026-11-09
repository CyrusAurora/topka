// The free-only provider chain: background model work (article analysis, scoring, card copy) prefers
// OpenCode Zen's free models, then the deployment's own free Agnes key, with OpenRouter as the last fallback
// (llm.ts keeps serving OpenRouter itself through the free guard of free-models.ts). Nothing here can
// bill anything: a provider joins only when configured and offering models that cost zero right now,
// and a refusal benches the provider or the route according to what the provider actually said.
import { credential } from "../config.ts";
import { freeGuardOn } from "./free-models.ts";
import { secondsToUtcMidnight } from "./receipts.ts";

export type ProviderId = "opencode" | "agnes" | "openrouter";

export interface ProviderRoute {
  provider: ProviderId; service: string; baseUrl: string; apiKey: string; extra?: Record<string, unknown>;
  /** OPENCODE_TRANSPORT=cli: calls go through the official CLI (./opencode-cli.ts). */
  transport?: "cli";
}

/** Request fields for one provider (AGNES_EXTRA_JSON / OPENCODE_EXTRA_JSON); an unreadable value falls back. */
function extraJson(value: string | undefined, fallback?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!value?.trim()) return fallback;
  try {
    const v = JSON.parse(value) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fallback;
  } catch {
    return fallback;
  }
}

/** agnes-3.0-flash reasons by default and spends a short max_tokens on it, answering nothing; structured
 * tasks switch the reasoning off (its SGLang chat template reads enable_thinking). */
export const AGNES_DEFAULT_EXTRA = { chat_template_kwargs: { enable_thinking: false } };

const PROVIDER_IDS: readonly string[] = ["opencode", "agnes", "openrouter"];
const DEFAULT_PROVIDER_ORDER = "opencode,agnes,openrouter";

function splitList(raw: string): string[] {
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** A provider takes calls when it is configured: a key for OpenCode and Agnes, the LLM_FREE_MODELS
 * guard for the OpenRouter fallback. */
function configured(p: ProviderId): boolean {
  return p === "opencode" ? !!credential("models", "OPENCODE_API_KEY")
    : p === "agnes" ? !!credential("models", "AGNES_API_KEY")
    : freeGuardOn("llm");
}

/** LLM_PROVIDER_ORDER (comma list, default "opencode,agnes,openrouter"), keeping only known ids that
 * are configured: opencode needs OPENCODE_API_KEY, agnes needs AGNES_API_KEY, openrouter needs
 * freeGuardOn("llm") (from ./free-models.ts). Duplicates removed. */
export function providerOrder(): ProviderId[] {
  const wanted = splitList(process.env.LLM_PROVIDER_ORDER?.trim() || DEFAULT_PROVIDER_ORDER);
  return wanted.filter((p): p is ProviderId => PROVIDER_IDS.includes(p)).filter((p) => configured(p));
}

/** True when the chain has at least one of opencode/agnes configured (otherwise llm.ts keeps the old
 * OpenRouter-only path). */
export function chainOn(): boolean {
  return configured("opencode") || configured("agnes");
}

/** The route a provider serves calls on. Never log it or carry it anywhere else: it holds the key. */
export function routeFor(p: ProviderId): ProviderRoute | null {
  if (p === "opencode") {
    const apiKey = credential("models", "OPENCODE_API_KEY");
    if (!apiKey) return null;
    const transport = process.env.OPENCODE_TRANSPORT === "cli" ? { transport: "cli" as const } : {};
    return { provider: "opencode", service: "opencode", baseUrl: credential("models", "OPENCODE_BASE_URL") || "https://opencode.ai/inference/openai/v1", apiKey, extra: extraJson(process.env.OPENCODE_EXTRA_JSON), ...transport };
  }
  if (p === "agnes") {
    const apiKey = credential("models", "AGNES_API_KEY");
    if (!apiKey) return null;
    return { provider: "agnes", service: "agnes", baseUrl: credential("models", "AGNES_BASE_URL") || "https://apihub.agnes-ai.com/v1", apiKey, extra: extraJson(process.env.AGNES_EXTRA_JSON, AGNES_DEFAULT_EXTRA) };
  }
  return null; // openrouter: llm.ts goes through its own path
}

/** OpenCode's free list = ids in the live list ∩ ids ending "-free" on the docs page ∩ models.dev
 * entries whose cost object exists and every value is 0, minus big-pickle/nemotron; sorted by the
 * first entry of `order` each id contains (ids matching none go last, stable). Anything unreadable
 * contributes nothing (fail closed: an empty result). */
export function opencodeFreeFrom(live: unknown, docsHtml: string, modelsDev: unknown, order?: string[]): string[] {
  const docs = new Set<string>();
  for (const m of docsHtml.matchAll(/\b[a-z0-9.-]+-free\b/g)) docs.add(m[0]!);
  const devModels = (modelsDev as { opencode?: { models?: unknown } | null } | null)?.opencode?.models;
  const devFree = new Set<string>();
  if (devModels && typeof devModels === "object") {
    for (const [id, entry] of Object.entries(devModels as Record<string, { cost?: unknown } | null>)) {
      if (allZeroCost(entry?.cost)) devFree.add(id);
    }
  }
  const ranks = (order ?? splitList(DEFAULT_OPENCODE_FREE_ORDER)).map((s) => s.trim()).filter(Boolean);
  const rank = (id: string) => {
    const at = ranks.findIndex((name) => id.includes(name));
    return at === -1 ? ranks.length : at;
  };
  return liveIds(live)
    .filter((id) => !/big-pickle|nemotron/i.test(id) && docs.has(id) && devFree.has(id))
    .sort((a, b) => rank(a) - rank(b));
}

/** The live ids of GET /zen/v1/models ({ data: [{ id }] }), in order; an unreadable list is none. */
function liveIds(live: unknown): string[] {
  const data = (live as { data?: unknown } | null)?.data;
  const ids: string[] = [];
  if (Array.isArray(data)) {
    for (const m of data) {
      const id = (m as { id?: unknown } | null)?.id;
      if (typeof id === "string" && id) ids.push(id);
    }
  }
  return ids;
}

/** models.dev records what a model costs: the cost object must exist and every field must be zero. */
function allZeroCost(cost: unknown): boolean {
  if (!cost || typeof cost !== "object") return false;
  return Object.values(cost as Record<string, unknown>).every((v) => (typeof v === "number" ? v === 0 : typeof v === "string" && /^0(\.0+)?$/.test(v.trim())));
}

const FREE_CACHE_MS = 60 * 60_000;
/** An inventory that could not be read is retried sooner; meanwhile nothing is offered. */
const FREE_FAILED_CACHE_MS = 5 * 60_000;
const DEFAULT_OPENCODE_FREE_ORDER = "deepseek,glm,mimo,minimax,beam,longcat";

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return text;
}

async function readOpencodeFree(): Promise<{ models: string[]; failed: boolean }> {
  try {
    const [liveText, docsHtml, devText] = await Promise.all([
      fetchText(process.env.OPENCODE_MODELS_URL || "https://opencode.ai/zen/v1/models"),
      fetchText(process.env.OPENCODE_DOCS_URL || "https://opencode.ai/v2/docs/console/models/"),
      fetchText(process.env.MODELS_DEV_URL || "https://models.dev/api.json"),
    ]);
    const order = splitList(process.env.OPENCODE_FREE_ORDER?.trim() || DEFAULT_OPENCODE_FREE_ORDER);
    return { models: opencodeFreeFrom(JSON.parse(liveText), docsHtml, JSON.parse(devText), order), failed: false };
  } catch {
    // One unreadable source answers for all three: until it verifies again nothing is free.
    return { models: [], failed: true };
  }
}

let inventory: { models: string[]; expires: number; pending?: Promise<string[]> } = { models: [], expires: 0 };

/** OpenCode's free stock right now, fetched from the three sources (20 s each) and cached an hour (5
 * minutes when a fetch failed, yielding [] until then). Refresh with { refresh: true }. */
export async function opencodeFreeModels(opts: { refresh?: boolean } = {}): Promise<string[]> {
  if (!opts.refresh && inventory.expires > Date.now()) return inventory.models;
  if (inventory.pending) return inventory.pending;
  const pending = readOpencodeFree().then(({ models, failed }) => {
    inventory = { models, expires: Date.now() + (failed ? FREE_FAILED_CACHE_MS : FREE_CACHE_MS) };
    if (!models.length) console.error(JSON.stringify({ level: "warn", msg: "NO_FREE_OPENCODE_MODEL" }));
    return models;
  });
  inventory.pending = pending;
  return pending;
}

/** OPENCODE_ALLOW (comma list of exact ids) narrows the free stock further, e.g. to the
 * zero-retention models; unset keeps the whole free stock. */
export function allowedOpencode(models: string[], allow: string | undefined): string[] {
  const ids = splitList(allow ?? "");
  return ids.length ? models.filter((m) => ids.includes(m)) : models;
}

/** The models a provider offers right now (the caller skips benched ones with isBenched): OpenCode
 * its inventory; Agnes the one model the deployment picks (default agnes-3.0-flash); OpenRouter none
 * — llm.ts keeps serving OpenRouter itself through the free guard. */
export async function candidateModels(p: ProviderId): Promise<string[]> {
  if (p === "opencode") return allowedOpencode(await opencodeFreeModels(), process.env.OPENCODE_ALLOW);
  if (p === "agnes") return [process.env.AGNES_MODEL || "agnes-3.0-flash"];
  return [];
}

const benches = new Map<string, { until: number; reason: string }>();

export function benchProvider(p: ProviderId, seconds: number, reason: string): void {
  benches.set(p, { until: Date.now() + seconds * 1000, reason });
  console.error(JSON.stringify({ level: "warn", msg: "free provider benched", provider: p, seconds, reason }));
}

export function benchRoute(p: ProviderId, model: string, seconds: number, reason: string): void {
  benches.set(`${p}:${model}`, { until: Date.now() + seconds * 1000, reason });
  console.error(JSON.stringify({ level: "warn", msg: "free provider benched", provider: p, model, seconds, reason }));
}

function sittingOut(key: string): boolean {
  const b = benches.get(key);
  return !!b && b.until > Date.now();
}

/** Seconds until a benched route (or its provider) is back; 0 when it is not benched. */
export function benchedSeconds(p: ProviderId, model?: string): number {
  const now = Date.now();
  const left = [p, ...(model ? [`${p}:${model}`] : [])].map((k) => benches.get(k)).filter((b) => b && b.until > now).map((b) => (b!.until - now) / 1000);
  return left.length ? Math.max(...left) : 0;
}

/** Out when the provider itself is benched, or — given a model — when that route is. */
export function isBenched(p: ProviderId, model?: string): boolean {
  return (!!model && sittingOut(`${p}:${model}`)) || sittingOut(p);
}

/** Clears the inventory cache and the benches (tests). */
export function resetFreeChain(): void {
  inventory = { models: [], expires: 0 };
  benches.clear();
}

/** How to treat a refused call. status 0 = connect failure. text = the error message/body (may be
 * truncated). Check the rules in this order; null means the caller rethrows. */
export function classifyRejection(p: ProviderId, status: number, text: string, retryAfter?: number): { scope: "provider" | "route"; seconds: number; reason: string } | null {
  if (/FreeTierError|free tier can only be used/i.test(text)) return { scope: "provider", seconds: secondsToUtcMidnight(), reason: "free tier refused" };
  if (status === 402 || (p === "agnes" && /billing|insufficient|balance|quota|credit|payment/i.test(text))) return { scope: "provider", seconds: secondsToUtcMidnight(), reason: "billing/quota" };
  if (status === 401 || status === 403) return { scope: "provider", seconds: 3600, reason: `HTTP ${status}` };
  if (status === 429) return { scope: "route", seconds: retryAfter ?? 60, reason: "HTTP 429" };
  if (status === 404) return { scope: "route", seconds: 3600, reason: "HTTP 404" };
  if (status >= 500 || status === 0) return { scope: "route", seconds: 120, reason: `HTTP ${status || "connect"}` };
  return null;
}
