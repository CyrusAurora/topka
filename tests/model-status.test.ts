// Who answers a reader's web chat (P0 chat error states): /api/me/model-status tells the truth from
// configuration (MODEL_CALLS_ENABLED, a usable BYOK key, the instance's routes), and the chat endpoint
// refuses up front with no_model when nothing can answer, instead of a turn that can only fail.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { config } from "@topka/backend/config";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { upsertKey, deleteKey, resolveUserLlmKey } from "@topka/backend/accounts/user-keys";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";
import { instanceModelStatus, modelStatus } from "@topka/backend/providers/availability";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const MASTER = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");
const app = await buildApp();
let userId = "";
let cookie = "";

const NO_MODEL = { LLM_BASE_URL: "", LLM_API_KEY: "", LLM_MODEL: "", LLM_PROVIDER_ORDER: "", LLM_FREE_MODELS: "", AGNES_API_KEY: "", OPENCODE_API_KEY: "", OPENROUTER_API_KEY: "" };

before(async () => {
  Object.assign(process.env, NO_MODEL, { KEY_ENCRYPTION_SECRET: MASTER });
  const r = await registerWithInvite({ code: "", email: `status-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.77" }, sql, "open");
  userId = r.user.id;
  cookie = `${SESSION_COOKIE}=${r.token}`;
});

after(async () => {
  delete process.env.KEY_ENCRYPTION_SECRET;
  config.modelCallsEnabled = true;
  await app.close();
  await closeDb();
});

test("the instance status follows MODEL_CALLS_ENABLED and the configured route", () => {
  config.modelCallsEnabled = true;
  Object.assign(process.env, NO_MODEL);
  assert.deepEqual(instanceModelStatus(), { available: false, reason: "not-configured", via: null });
  Object.assign(process.env, { LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_API_KEY: "k" });
  assert.equal(instanceModelStatus().available, false, "a key without a model is not a route");
  process.env.LLM_MODEL = "m";
  assert.deepEqual(instanceModelStatus(), { available: true, reason: null, via: "configured" });
  config.modelCallsEnabled = false;
  assert.deepEqual(instanceModelStatus(), { available: false, reason: "model-calls-off", via: null });
  config.modelCallsEnabled = true;
  Object.assign(process.env, NO_MODEL);
});

test("model-status: signed out is 401; no route answers none; the chat refuses with no_model", async () => {
  const anon = await app.inject({ method: "GET", url: "/api/me/model-status" });
  assert.equal(anon.statusCode, 401);
  const res = await app.inject({ method: "GET", url: "/api/me/model-status", headers: { cookie } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  const body = res.json() as Awaited<ReturnType<typeof modelStatus>>;
  assert.deepEqual([body.chat, body.reason, body.byokAvailable, body.userKey.stored], ["none", "not-configured", true, false]);

  const turnsBefore = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM assistant_turns WHERE user_id = ${userId}`)[0]!.n;
  const post = await app.inject({ method: "POST", url: "/api/me/chat", headers: { cookie, "content-type": "application/json" }, payload: JSON.stringify({ text: "帮我跟踪机器人", clientId: `c-${T}` }) });
  assert.deepEqual([post.statusCode, post.json().code], [409, "no_model"], post.body);
  assert.match(post.json().detail as string, /设置/);
  const turnsAfter = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM assistant_turns WHERE user_id = ${userId}`)[0]!.n;
  assert.equal(turnsAfter, turnsBefore, "a refused send records no turn");

  const anonPost = await app.inject({ method: "POST", url: "/api/me/chat", headers: { "content-type": "application/json" }, payload: JSON.stringify({ text: "x" }) });
  assert.equal(anonPost.statusCode, 401);
});

test("a key without a base URL is flagged; one under any provider name with a base URL answers the chat", async () => {
  await upsertKey(userId, "openai", { apiKey: "sk-test-aaaa", baseUrl: null, model: "gpt-x" });
  let s = await modelStatus(userId);
  assert.deepEqual([s.chat, s.userKey.stored, s.userKey.usable, s.userKey.problem], ["none", true, false, "missing-base-url"]);

  await upsertKey(userId, "openai", { apiKey: "sk-test-bbbb", baseUrl: "https://example.invalid/v1", model: null });
  s = await modelStatus(userId);
  assert.deepEqual([s.chat, s.userKey.problem], ["none", "missing-model"], "no model of its own and no instance default");

  await upsertKey(userId, "openai", { apiKey: "sk-test-cccc", baseUrl: "https://example.invalid/v1", model: "gpt-x" });
  s = await modelStatus(userId);
  assert.deepEqual([s.chat, s.userKey.usable, s.userKey.last4, s.reason], ["user-key", true, "cccc", null]);
  const resolved = await resolveUserLlmKey(userId);
  assert.equal(resolved?.provider, "openai", "the chat path uses the reader's key even when it is not named llm");
  assert.ok(!JSON.stringify(s).includes("sk-test"), "no key material in the status");

  config.modelCallsEnabled = false;
  s = await modelStatus(userId);
  assert.deepEqual([s.chat, s.reason], ["none", "model-calls-off"]);
  config.modelCallsEnabled = true;
  await deleteKey(userId, "openai");
});

test("the instance answering is reported as instance", async () => {
  Object.assign(process.env, { LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_API_KEY: "k", LLM_MODEL: "m" });
  const s = await modelStatus(userId);
  assert.deepEqual([s.chat, s.instance.via], ["instance", "configured"]);
  Object.assign(process.env, NO_MODEL);
});
