// Whether a reader's chat turn can reach a model right now, from configuration only (no model call,
// no secret leaves this file). The chat page and 设置 show it; the chat endpoint refuses up front when
// nothing can answer, instead of letting the reader wait on a turn that cannot succeed.
//
// The order mirrors llm.ts chatJson: MODEL_CALLS_ENABLED gates everything; then the reader's own key
// (BYOK, needs a base URL and a model), a plugin's interactive route, the free chain (OpenCode /
// Agnes), the OpenRouter free guard, and finally the plain LLM_BASE_URL + LLM_API_KEY + LLM_MODEL.
import { config, credential } from "../config.ts";
import { encryptionConfigured, listKeys, resolveUserLlmKey } from "../accounts/user-keys.ts";
import { interactiveChatRoutes } from "./chat-routes.ts";
import { chainOn } from "./free-chain.ts";
import { freeGuardOn } from "./free-models.ts";

export type InstanceModelReason = "model-calls-off" | "not-configured";

export interface InstanceModelStatus {
  available: boolean;
  /** Why not, when not available. */
  reason: InstanceModelReason | null;
  /** Which kind of route answers ("plugin", "free-chain", "free-guard", "configured"); never a key. */
  via: "plugin" | "free-chain" | "free-guard" | "configured" | null;
}

export function instanceModelStatus(): InstanceModelStatus {
  if (!config.modelCallsEnabled) return { available: false, reason: "model-calls-off", via: null };
  if (interactiveChatRoutes().some((r) => r.enabled() && !!r.model())) return { available: true, reason: null, via: "plugin" };
  if (chainOn()) return { available: true, reason: null, via: "free-chain" };
  const base = credential("models", "LLM_BASE_URL");
  const key = credential("models", "LLM_API_KEY");
  if (freeGuardOn("llm") && base && key) return { available: true, reason: null, via: "free-guard" };
  if (base && key && (process.env.LLM_MODEL ?? "").trim()) return { available: true, reason: null, via: "configured" };
  return { available: false, reason: "not-configured", via: null };
}

export interface ModelStatus {
  /** Who answers the reader's chat: their own key, the instance, or nobody. */
  chat: "user-key" | "instance" | "none";
  /** When chat is "none": model calls are off on this instance, or no route is configured. */
  reason: InstanceModelReason | null;
  instance: InstanceModelStatus;
  /** The instance can store readers' own keys (KEY_ENCRYPTION_SECRET is set). */
  byokAvailable: boolean;
  userKey: {
    /** Any key row saved. */
    stored: boolean;
    /** A saved key the chat can actually use (has a base URL and a model). */
    usable: boolean;
    /** Why a stored key is not used yet. */
    problem: "missing-base-url" | "missing-model" | null;
    last4: string | null;
  };
}

export async function modelStatus(userId: string): Promise<ModelStatus> {
  const instance = instanceModelStatus();
  const byokAvailable = encryptionConfigured();
  const keys = await listKeys(userId);
  const resolved = byokAvailable ? await resolveUserLlmKey(userId) : null;
  const model = resolved ? (resolved.model || process.env.LLM_MODEL || "").trim() : "";
  const usable = !!resolved && !!model;
  const problem = usable || !keys.length ? null : !keys.some((k) => k.baseUrl) || !resolved ? "missing-base-url" : "missing-model";
  const shown = resolved ? keys.find((k) => k.provider === resolved.provider) : keys[0];
  const userKey = { stored: keys.length > 0, usable, problem, last4: shown?.last4 ?? null } as ModelStatus["userKey"];
  if (!config.modelCallsEnabled) return { chat: "none", reason: "model-calls-off", instance, byokAvailable, userKey };
  if (usable) return { chat: "user-key", reason: null, instance, byokAvailable, userKey };
  if (instance.available) return { chat: "instance", reason: null, instance, byokAvailable, userKey };
  return { chat: "none", reason: instance.reason, instance, byokAvailable, userKey };
}
