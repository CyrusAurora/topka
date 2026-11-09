// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless an
// environment variable or the admin's model page picks one of the named presets below.
import type { z } from "zod";
import { config, credential } from "../config.ts";
import { sha256 } from "../lib/ids.ts";
import { BudgetExceededError, completeReceipt, INTERACTIVE_PURPOSES, paidRequest, ProviderRejectedError, rejectReceivedResponse, secondsToUtcMidnight } from "./receipts.ts";
import { sql } from "../db.ts";
import { assertOpenRouterQuota, auditFreeResponse, benchModel, freeCandidates, freeGuardOn, NoFreeModelError, noteRateLimited, noteUnusable, noteUsable, pickFreeModel, someBenched } from "./free-models.ts";
import { benchedSeconds, benchProvider, benchRoute, candidateModels, chainOn, classifyRejection, isBenched, providerOrder, routeFor, type ProviderId } from "./free-chain.ts";
import { opencodeCliComplete } from "./opencode-cli.ts";
import { benchChatRoute, chatRouteBenched, interactiveChatRoutes, type ChatRouteCompleteInput, type ChatRouteCompletion } from "./chat-routes.ts";

export type Route = {
  provider: string;
  service: string;
  baseUrl: string;
  apiKey: string;
  transport?: "plugin";
  /** A reader's own key (BYOK): its Base URL is checked against the SSRF guard on every call. */
  userSupplied?: boolean;
  extra?: Record<string, unknown>;
  complete?: (input: ChatRouteCompleteInput) => Promise<ChatRouteCompletion>;
};

export interface ModelSpec {
  key: string;
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  jsonMode: boolean;
  vision?: boolean;
}

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_EXTRA_JSON must be a JSON object, e.g. {\"enable_thinking\": false}");
  }
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  // Named presets (the models Topka itself runs on); each needs its own key.
  // GLM 5.3 Flash always reasons; the lowest effort keeps short structured tasks fast.
  "glm-5.3-flash": {
    key: "glm-5.3-flash", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled" }, reasoning_effort: "low" }, jsonMode: true,
  },
  // The scorer's parameters for glm-5.3-flash (score calls; temperature 1 is set per call).
  "glm-5.3-flash-selection": {
    key: "glm-5.3-flash-selection", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 }, jsonMode: true,
  },
  // DeepSeek Flash reasons by default; structured tasks switch it off unless the -think variant is used.
  "deepseek-flash": {
    key: "deepseek-flash", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "deepseek-flash-think": {
    key: "deepseek-flash-think", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY", jsonMode: true,
  },
  "qwen3.7-flash": {
    key: "qwen3.7-flash", service: "dashscope", model: "qwen3.7-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "qwen3.8-flash": {
    key: "qwen3.8-flash", service: "dashscope", model: "qwen3.8-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "mimo-v2.6-flash": {
    key: "mimo-v2.6-flash", service: "mimo", model: "mimo-v2.6-flash",
    baseUrlEnv: "XIAOMI_MIMO_BASE_URL", apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "qwen3-vl-flash": {
    key: "qwen3-vl-flash", service: "dashscope", model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: false, vision: true,
  },
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
  /** The user whose own key should be preferred (BYOK: user → instance → fail). */
  userId?: string;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

export class ModelOutputError extends Error {}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET_BEFORE_SEND", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

/** Request fields a free-only call must never carry: server-side fallbacks may pick a paid model. */
const ROUTING_FIELDS = ["models", "route"];
const ZERO_PRICE = { prompt: 0, completion: 0, request: 0, image: 0 };

function isOpenRouter(baseUrl: string): boolean {
  return /openrouter\.ai/.test(baseUrl);
}

function retryAfterSeconds(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(1, Math.ceil(n));
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(1, Math.ceil((at - Date.now()) / 1000));
}

/**
 * A reader's Base URL is checked before each call (baseUrlProblem), but it is a name they control and
 * fetch resolves it again: dial through the guarded lookup so the address actually connected is the
 * one checked (a DNS answer flipped to loopback, private or metadata between the two is refused).
 */
async function userEndpointFetch(url: string, init: RequestInit): Promise<Response> {
  const { privateBaseUrlAllowed } = await import("../accounts/user-keys.ts");
  if (privateBaseUrlAllowed()) return fetch(url, init);
  const { guardedDirectDispatcher, undiciFetch } = await import("../lib/http-fetch.ts");
  return (await undiciFetch(url, { ...(init as object), dispatcher: guardedDirectDispatcher() } as never)) as unknown as Response;
}

/** The user's own key, shaped as a route; null when they have none or it is incomplete. */
async function userKeyRoute(userId: string): Promise<(Route & { model: string }) | null> {
  const { resolveUserLlmKey } = await import("../accounts/user-keys.ts");
  const key = await resolveUserLlmKey(userId);
  if (!key || !key.baseUrl) return null;
  return {
    provider: key.provider, service: "llm",
    baseUrl: key.baseUrl, apiKey: key.apiKey, userSupplied: true,
    model: key.model || (process.env.LLM_MODEL ?? ""),
  };
}

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  // BYOK: the interactive path prefers the user's own key (user → instance → fail); a
  // user with a stored key never spends the instance's budget on their chat turns.
  const userRoute = opts.userId ? await userKeyRoute(opts.userId) : null;
  if (userRoute) return chatJsonWith(opts, spec, userRoute.model, false, userRoute);
  // A plugin may register an interactive chat route (e.g. a free quota of its own) that answers before
  // the configured chain. The first enabled route that is not benched gets the call.
  if (spec.key === "default" && INTERACTIVE_PURPOSES.has(opts.purpose)) {
    for (const route of interactiveChatRoutes()) {
      if (!route.enabled() || chatRouteBenched(route.id)) continue;
      const model = route.model();
      if (!model) continue;
      try {
        return await chatJsonWith(opts, spec, model, false, {
          provider: route.provider,
          service: route.service,
          baseUrl: "plugin",
          apiKey: "plugin",
          transport: "plugin",
          complete: (input) => route.complete(input),
        });
      } catch (error) {
        if (error instanceof ProviderRejectedError) {
          const status = error.status ?? 0;
          const seconds = status === 402 ? 6 * 3600 : status === 429 ? 20 : 300;
          benchChatRoute(route.id, seconds, status === 402 ? "free quota used up" : `HTTP ${status || "connect"}`);
          console.log(JSON.stringify({ level: "warn", msg: "chat route unavailable, falling back", route: route.id, status, seconds }));
        } else if (error instanceof ModelOutputError) {
          console.log(JSON.stringify({ level: "warn", msg: "chat route output unusable, falling back", route: route.id }));
        } else if (error instanceof BudgetExceededError) {
          continue;
        } else {
          throw error;
        }
      }
    }
  }
  if (spec.key === "default" && chainOn()) return chatJsonChain(opts, spec);
  const guarded = spec.key === "default" && freeGuardOn("llm");
  if (!guarded) return chatJsonWith(opts, spec, spec.model, false);
  return openRouterFree(opts, spec);
}

async function openRouterFree<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec): Promise<ChatJsonResult<z.infer<S>>> {
  // Free-only: the first verified-free candidate; one that is rate-limited or gone sits out and the
  // next one is tried. None left: NoFreeModelError, so the work waits instead of failing.
  // Unusable output (no JSON, wrong shape) moves on to the next candidate too. When the only ones left
  // answer junk while better ones are rate-limited (the 08:00 Taipei free-quota rush), the call waits
  // for those instead of spending the article's attempts on the junk.
  await assertOpenRouterQuota(opts.purpose);
  const tries = freeCandidates("llm").length;
  const tried = new Set<string>();
  let junk: ModelOutputError | null = null;
  for (let i = 0; i < tries; i++) {
    let model: string;
    try { model = await pickFreeModel("llm", tried); }
    catch (e) { if (junk && e instanceof NoFreeModelError) break; throw e; }
    tried.add(model);
    try {
      const out = await chatJsonWith(opts, spec, model, true);
      noteUsable("llm", model);
      return out;
    } catch (error) {
      if (error instanceof ModelOutputError) { noteUnusable("llm", model); junk = error; continue; }
      if (!(error instanceof ProviderRejectedError)) throw error;
      const status = error.status ?? 0;
      if (status === 429) noteRateLimited("llm", model, (error as { retryAfter?: number }).retryAfter);
      else if (status === 402) benchModel("llm", model, 6 * 3600, "HTTP 402 (would need credits)");
      else if ([403, 404].includes(status) || status >= 500 || status === 0) benchModel("llm", model, status >= 500 || status === 0 ? 120 : 3600, `HTTP ${status || "connect"}`);
      else throw error;
    }
  }
  if (junk) {
    if (await someBenched("llm")) throw new NoFreeModelError("llm", 60, "the free models left answer unusable output; waiting for the rate-limited ones");
    throw junk;
  }
  await pickFreeModel("llm"); // throws NoFreeModelError when every candidate is benched
  throw new NoFreeModelError("llm", 60, "every free candidate was refused");
}

async function chatJsonChain<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec): Promise<ChatJsonResult<z.infer<S>>> {
  let waiting: BudgetExceededError | null = null;
  // A route sitting out a rate limit is back in seconds: the work should wait that long, not for a
  // later provider's day-long wait (OpenRouter's UTC day).
  let soonest = Infinity;
  for (const p of providerOrder()) {
    if (p === "openrouter") {
      try { return await openRouterFree(opts, spec); } catch (e) { if (e instanceof BudgetExceededError) { waiting = waiting ?? e; continue; } throw e; }
    }
    if (isBenched(p)) continue;
    const provided = routeFor(p);
    if (!provided) continue;
    for (const model of await candidateModels(p)) {
      const route: Route = provided.transport === "cli"
        ? { ...provided, transport: "plugin", complete: (input) => opencodeCliComplete(model, input, provided.apiKey) }
        : { ...provided, transport: undefined };
      if (isBenched(p, model)) { soonest = Math.min(soonest, benchedSeconds(p, model)); continue; }
      try { return await chatJsonWith(opts, spec, model, false, route); }
      catch (e) {
        if (e instanceof BudgetExceededError) { waiting = waiting ?? e; break; }
        if (!(e instanceof ProviderRejectedError)) throw e;
        const c = classifyRejection(p, e.status ?? 0, e.message, (e as { retryAfter?: number }).retryAfter);
        if (!c) throw e;
        if (c.scope === "provider") { benchProvider(p, c.seconds, c.reason); break; }
        benchRoute(p, model, c.seconds, c.reason);
        soonest = Math.min(soonest, c.seconds);
      }
    }
  }
  if (Number.isFinite(soonest) && (!waiting || soonest < waiting.retryAfterSeconds)) {
    // Name what the others are waiting on too (e.g. OpenRouter's day budget), or a long wait hides
    // behind the short one in every alert.
    throw new NoFreeModelError("llm", Math.max(30, Math.ceil(soonest)), `free providers are rate-limited for a moment${waiting ? `; also waiting: ${waiting.message}` : ""}`);
  }
  throw waiting ?? new NoFreeModelError("llm", 300, "every free provider is unavailable or cooling down");
}

async function chatJsonWith<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec, model: string, freeOnly: boolean, route?: Route): Promise<ChatJsonResult<z.infer<S>>> {
  const baseUrl = route ? route.baseUrl : credential("models", spec.baseUrlEnv);
  const apiKey = route ? route.apiKey : credential("models", spec.apiKeyEnv);
  if (!baseUrl || !apiKey || !model) throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL or LLM_FREE_MODELS" : ""})`);
  if (route) freeOnly = false;
  if (route?.userSupplied) {
    // The reader chose this URL: refuse loopback / private / metadata targets (checked per call, so a
    // key saved before the guard, or a name whose DNS answer changed, cannot reach inside).
    const { baseUrlProblem } = await import("../accounts/user-keys.ts");
    const problem = await baseUrlProblem(baseUrl);
    if (problem) throw new ProviderRejectedError(`user base URL refused: ${problem}`, 400, false);
  }

  const temperature = opts.temperature ?? 0.2;
  const maxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.key.endsWith("-think") ? 4000 : 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  // A route carries its own request fields: the deployment's LLM_EXTRA_JSON is written for OpenRouter.
  const specExtra = route ? route.extra : spec.extra;
  const extra: Record<string, unknown> = { ...(specExtra ?? {}) };
  if (freeOnly) {
    for (const f of ROUTING_FIELDS) delete extra[f];
    // OpenRouter refuses rather than routes when no zero-priced endpoint can serve the request.
    const provider = (extra.provider && typeof extra.provider === "object" ? extra.provider : {}) as Record<string, unknown>;
    extra.provider = { ...provider, max_price: ZERO_PRICE };
  }
  const body: Record<string, unknown> = {
    model,
    messages: [
      // A prompt given as one user message (the title/summary prompts) has no system message.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      // Multimodal parts go through as parts; plain objects are sent as JSON text.
      { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
    ...extra,
  };
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  if (!route && isOpenRouter(baseUrl)) {
    // OpenRouter's app attribution headers.
    headers["HTTP-Referer"] = process.env.LLM_APP_URL || config.siteUrl;
    headers["X-Title"] = process.env.LLM_APP_TITLE || "Topka";
  }

  const receipt = await paidRequest(
    {
      service: route ? route.service : spec.service,
      model,
      purpose: opts.purpose,
      subject: opts.subject,
      identity: { model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, extra: specExtra ?? null, ...(route ? { provider: route.provider } : {}) },
      requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens, ...(route ? { provider: route.provider } : {}) },
      attemptTag: opts.attemptTag,
    },
    async () => {
      const started = Date.now();
      let json: Record<string, unknown>;
      let requestId: string | null = null;
      if (route?.transport === "plugin") {
        if (!route.complete) throw new Error(`Chat route ${route.provider} has no complete handler`);
        const messages = (body.messages as Array<{ role: string; content: unknown }>).map((m) => ({ ...m, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }));
        const r = await route.complete({ messages, temperature, maxTokens, timeoutMs: opts.timeoutMs ?? 55_000 });
        json = { id: null, model: r.model, provider: r.provider, choices: [{ message: { content: r.text }, finish_reason: "stop" }], usage: r.usage ?? null };
      } else {
        let res: Response;
        try {
          const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
          const init = {
            method: "POST",
            headers,
            // A reader's endpoint may not bounce the request (and their key) somewhere else.
            ...(route?.userSupplied ? { redirect: "error" as const } : {}),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
          };
          res = route?.userSupplied ? await userEndpointFetch(url, init) : await fetch(url, init);
        } catch (error) {
          if ((error as { code?: string }).code === "EBLOCKED" || (error as { cause?: { code?: string } }).cause?.code === "EBLOCKED" || /Blocked (private address|host)/.test(String(error))) {
            throw new ProviderRejectedError(`base url refused: ${String((error as Error).message ?? error).slice(0, 200)}`, null, false);
          }
          if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true);
          throw error;
        }
        const text = await res.text();
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          throw Object.assign(new ProviderRejectedError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable), { retryAfter: retryAfterSeconds(res) ?? undefined });
        }
        try {
          json = JSON.parse(text);
        } catch {
          json = { unparsable: text.slice(0, 20000) };
        }
        requestId = (json.id as string | undefined) ?? res.headers.get("x-request-id");
      }
      const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
      const reported = usage && typeof usage.cost === "number" ? usage.cost : null;
      if (freeOnly) {
        const problem = auditFreeResponse("llm", model, json as never);
        console.log(JSON.stringify({ level: problem ? "error" : "info", msg: problem ? "FREE_MODEL_ALERT" : "llm call", purpose: opts.purpose, requested: model, used: json.model ?? null, cost: reported, ...(problem ? { problem } : {}) }));
        // The answer is already in hand; the model sits out so the next call goes elsewhere.
        if (problem) benchModel("llm", model, 24 * 3600, problem);
      }
      if (route && reported !== null && reported !== 0) {
        console.error(JSON.stringify({ level: "error", msg: "FREE_MODEL_ALERT", provider: route.provider, model, cost: reported }));
        benchProvider(route.provider as ProviderId, secondsToUtcMidnight(), "reported a cost");
      }
      return {
        response: { ...json, _latencyMs: Date.now() - started },
        requestId,
        usage,
        cost: reported === null ? null : { amount: reported, currency: "USD", basis: "actual" },
      };
    },
  );

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer.
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`);
  }
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
}

export async function markReceiptsCompleted(ids: number[]): Promise<void> {
  for (const id of ids) await completeReceipt(sql, id);
}
