// The built-in demo model: a deterministic stand-in for a chat model, so a fresh install can walk the
// model-backed flows (对话 creating a project, phone-card copy) offline and at no cost. It never reads
// the network and never pretends to understand anything: questions are canned, the summary repeats the
// reader's words, sources are picked by word overlap, and every answer is labelled as demo output.
//
// On when LLM_DEMO=true, or when LLM_DEMO is unset, DEMO_SEED=true and no real model is configured
// (MODEL_CALLS_ENABLED with a key, a free chain or a plugin route). LLM_DEMO=false keeps it off.
// Only the purposes in DEMO_PURPOSES use it: collected articles are never scored or summarised by it,
// so no invented analysis reaches real content.
import { config, credential } from "../config.ts";
import { interactiveChatRoutes } from "./chat-routes.ts";
import { chainOn } from "./free-chain.ts";
import { freeGuardOn } from "./free-models.ts";
import type { ChatRouteCompleteInput, ChatRouteCompletion } from "./chat-routes.ts";
import { demoAnswer } from "@topka/contracts/demo-answers";

export const DEMO_MODEL_ID = "topka-demo";
/** 对话 (intake and the change/delete assistant) and the phone-card copy. */
export const DEMO_PURPOSES: ReadonlySet<string> = new Set(["project_assistant", "mobile_card"]);

const truthy = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";

/** A real model can answer on this instance (the order chatJson tries). */
export function realModelConfigured(): boolean {
  if (!config.modelCallsEnabled) return false;
  if (interactiveChatRoutes().some((r) => r.enabled() && !!r.model())) return true;
  if (chainOn()) return true;
  const base = credential("models", "LLM_BASE_URL");
  const key = credential("models", "LLM_API_KEY");
  if (freeGuardOn("llm") && base && key) return true;
  return !!(base && key && (process.env.LLM_MODEL ?? "").trim());
}

export function demoModelOn(): boolean {
  const flag = (process.env.LLM_DEMO ?? "").trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return truthy(process.env.DEMO_SEED) && !realModelConfigured();
}

// The answers themselves are pure and shared with the online demo (packages/contracts/src/demo-answers.ts).
export { demoAnswer, demoTarget } from "@topka/contracts/demo-answers";

/** A chat-route style completion for chatJson's plugin transport. */
export function demoComplete(purpose: string) {
  return async (input: ChatRouteCompleteInput): Promise<ChatRouteCompletion> => {
    const system = input.messages.find((m) => m.role === "system")?.content ?? "";
    const user = input.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    return { text: demoAnswer({ purpose, system, user }), model: DEMO_MODEL_ID, provider: "demo", usage: { cost: 0 } };
  };
}
