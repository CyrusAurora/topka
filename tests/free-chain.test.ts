// Free-only chain: the OpenCode free inventory must agree across its three sources and stay clear of
// known traps, refusals classify into provider/route benches, and the provider order follows
// configuration (env saved and restored; no database and no network needed here).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  benchProvider, benchRoute, chainOn, classifyRejection, isBenched, opencodeFreeFrom, providerOrder, resetFreeChain,
} from "../packages/backend/src/providers/free-chain.ts";

test("a model is free only when the live list, a -free id on the docs page and all-zero models.dev costs agree", () => {
  const live = { data: [
    { id: "deepseek-v4.1-flash-free" },
    { id: "glm-5.3-flash-free" },
    { id: "big-pickle" },
    { id: "nemotron-3.5-super-free" },
    { id: "paid-model" },
    { id: "minimax-m3.1-flash-free" },
  ] };
  const docsHtml = "Console models: deepseek-v4.1-flash-free glm-5.3-flash-free nemotron-3.5-super-free minimax-m3.1-flash-free";
  const modelsDev = {
    opencode: {
      models: {
        "paid-model": { cost: { input: 0, output: 0 } },
        "deepseek-v4.1-flash-free": { cost: { input: 0, output: 0 } },
        "glm-5.3-flash-free": { cost: { input: 0, output: 0 } },
        "nemotron-3.5-super-free": { cost: { input: 0, output: 0 } },
        "minimax-m3.1-flash-free": { cost: { input: 0.1, output: 0 } },
      },
    },
  };
  assert.deepEqual(opencodeFreeFrom(live, docsHtml, modelsDev, ["glm", "deepseek"]), ["glm-5.3-flash-free", "deepseek-v4.1-flash-free"]);
  assert.deepEqual(opencodeFreeFrom(null, docsHtml, modelsDev, ["glm", "deepseek"]), [], "an unreadable live list answers for everything");
});

test("refusals bench the provider when the free tier or billing is at fault, the route for transient ones", () => {
  const freeTier = classifyRejection("opencode", 403, "FreeTierError: free tier can only be used with the free models", 5);
  assert.equal(freeTier?.scope, "provider", "the free tier refusal wins over the HTTP status");
  assert.equal(freeTier?.reason, "free tier refused");
  assert.ok((freeTier?.seconds ?? 0) >= 60 && (freeTier?.seconds ?? 0) <= 86400, "benched until UTC midnight");

  const billing = classifyRejection("agnes", 400, "insufficient balance for this request", 9);
  assert.equal(billing?.scope, "provider", "a billing refusal takes the provider out from any status");
  assert.equal(billing?.reason, "billing/quota");
  assert.ok((billing?.seconds ?? 0) >= 60 && (billing?.seconds ?? 0) <= 86400);

  assert.deepEqual(classifyRejection("opencode", 429, "slow down", 7), { scope: "route", seconds: 7, reason: "HTTP 429" });
  assert.deepEqual(classifyRejection("opencode", 500, "upstream exploded"), { scope: "route", seconds: 120, reason: "HTTP 500" });
  assert.deepEqual(classifyRejection("opencode", 0, "ECONNRESET"), { scope: "route", seconds: 120, reason: "HTTP connect" });
  assert.equal(classifyRejection("opencode", 400, "bad request"), null);
});

test("providerOrder keeps only configured providers, in LLM_PROVIDER_ORDER order; chainOn needs a real key", () => {
  const saved = { ...process.env };
  try {
    for (const name of ["OPENCODE_API_KEY", "AGNES_API_KEY", "OPENCODE_BASE_URL", "AGNES_BASE_URL", "AGNES_MODEL", "LLM_FREE_MODELS", "LLM_PROVIDER_ORDER"]) delete process.env[name];
    process.env.AGNES_API_KEY = "test-agnes-key";
    assert.deepEqual(providerOrder(), ["agnes"], "default order, only the configured ids");
    assert.equal(chainOn(), true);

    process.env.LLM_PROVIDER_ORDER = "bogus,agnes,agnes";
    assert.deepEqual(providerOrder(), ["agnes"], "unknown ids and duplicates dropped");

    process.env.OPENCODE_API_KEY = "test-opencode-key";
    process.env.LLM_PROVIDER_ORDER = "agnes,opencode";
    assert.deepEqual(providerOrder(), ["agnes", "opencode"]);

    for (const name of ["AGNES_API_KEY", "OPENCODE_API_KEY", "LLM_PROVIDER_ORDER"]) delete process.env[name];
    assert.deepEqual(providerOrder(), [], "openrouter only counts behind the free guard");
    assert.equal(chainOn(), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("a provider bench covers every route of it, a route bench only its own model, reset clears both", () => {
  resetFreeChain();
  benchProvider("opencode", 60, "free tier refused");
  assert.equal(isBenched("opencode"), true);
  assert.equal(isBenched("opencode", "glm-5.3-flash-free"), true);
  assert.equal(isBenched("agnes"), false);

  resetFreeChain();
  benchRoute("opencode", "glm-5.3-flash-free", 60, "HTTP 429");
  assert.equal(isBenched("opencode", "glm-5.3-flash-free"), true);
  assert.equal(isBenched("opencode", "deepseek-v4.1-flash-free"), false);
  assert.equal(isBenched("opencode"), false, "a route bench is not a provider bench");

  resetFreeChain();
  assert.equal(isBenched("opencode", "glm-5.3-flash-free"), false);
});
