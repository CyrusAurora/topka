// Abuse guards on the two doors that spend shared resources: the chat (free-model calls) answers 429
// past CHAT_PER_MINUTE without calling the model and holds ASSISTANT_DAILY_TURNS per user per day;
// ingest answers 429 past 10 pushes a minute per client, and a wrong token never spends that window.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb } from "@topka/backend/db";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";
import { resetChatLimits } from "../apps/api/src/routes/assistant.ts";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const llm = await stub(() => ({
  id: "x", model: "stub", usage: { prompt_tokens: 5, completion_tokens: 5 },
  choices: [{ message: { content: JSON.stringify({ kind: "question", analysis: { vague: [] }, update: "好。", question: "关心哪方面？", options: ["A", "B"], action: "reply", projectRef: null, reply: "你好。", proposal: null }) } }],
}));
const INGEST = `ingest-${T}-0123456789abcdef`;
Object.assign(process.env, {
  LLM_BASE_URL: `${llm.url}/v1`, LLM_API_KEY: "test", LLM_MODEL: "stub-model",
  LLM_PROVIDER_ORDER: "", LLM_FREE_MODELS: "", MODEL_CALLS_ENABLED: "true",
  AGNES_API_KEY: "", OPENCODE_API_KEY: "", OPENROUTER_API_KEY: "",
  ASSISTANT_DAILY_TURNS: "40", CHAT_PER_MINUTE: "3", INGEST_TOKEN: INGEST,
});
const app = await buildApp();

async function account(n: number): Promise<string> {
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `rl ${T}` })).code;
  const r = await registerWithInvite({ code, email: `rl${n}-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.60" });
  return `${SESSION_COOKIE}=${r.token}`;
}
const chat = (cookie: string, text: string) =>
  app.inject({ method: "POST", url: "/api/me/chat", headers: { "content-type": "application/json", cookie }, payload: JSON.stringify({ text }) });

let a = "";
let b = "";
before(async () => { a = await account(1); b = await account(2); });
after(async () => { await llm.close(); await app.close(); await closeDb(); });

test("chat: past CHAT_PER_MINUTE a user gets 429 without a model call; others are unaffected", async () => {
  resetChatLimits();
  for (let i = 0; i < 3; i++) assert.equal((await chat(a, `你好 ${i}`)).statusCode, 200);
  const hits = llm.hits();
  const over = await chat(a, "再来一条");
  assert.equal(over.statusCode, 429, over.body);
  assert.equal(over.json().code, "rate_limited");
  assert.equal(over.headers["retry-after"], "60");
  assert.equal(llm.hits(), hits, "a limited message never reaches the model");
  assert.equal((await chat(b, "你好")).statusCode, 200, "the window is per user");
});

test("chat: the daily cap defers the turn honestly and skips the model", async () => {
  resetChatLimits();
  process.env.ASSISTANT_DAILY_TURNS = "1";
  try {
    const hits = llm.hits();
    const r = await chat(b, "今天第二条");
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, "deferred");
    assert.match(r.json().reply, /次数用完/);
    assert.equal(llm.hits(), hits);
  } finally {
    process.env.ASSISTANT_DAILY_TURNS = "40";
  }
});

test("ingest: 10 pushes a minute per authorized client, then 429; wrong tokens are 401 and never spend that window", async () => {
  // Wrong tokens do spend the coarse per-address ceiling (LIMITS.secret, 20 a minute) that stops token
  // guessing; codeql-hardening.test.ts covers that. Here they stay under it.
  const push = (token: string, ip: string) =>
    app.inject({ method: "POST", url: "/api/ingest/items", remoteAddress: ip, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, payload: JSON.stringify({ items: [] }) });
  for (let i = 0; i < 5; i++) assert.equal((await push("wrong-token-0123456789", "198.51.100.7")).statusCode, 401);
  const codes: number[] = [];
  for (let i = 0; i < 10; i++) codes.push((await push(INGEST, "198.51.100.7")).statusCode);
  assert.ok(codes.every((c) => c !== 429), codes.join(","));
  const last = await push(INGEST, "198.51.100.7");
  assert.equal(last.statusCode, 429);
  assert.equal(last.headers["retry-after"], "60");
  assert.notEqual((await push(INGEST, "198.51.100.8")).statusCode, 429, "the window is per client");
});
