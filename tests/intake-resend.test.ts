// The server intake (outside-client fallback / web): when a turn's model call timed out (receipt "unknown"),
// the person's 「再发一次」 — the same words, a new clientId — must reach the model again instead of
// failing at once for the next 30 minutes; a repeat of the same clientId still never re-sends.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { intakeTurn } from "@topka/backend/assistant/intake";

const T = tag();
const USER = `resend-${T}`;
const llm = await stub(() => ({ id: "x", model: "stub", choices: [{ message: { content: JSON.stringify({ kind: "question", update: "明白，你想跟踪机器人。", question: "你最关心哪方面？", options: ["量产", "融资"] }) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
Object.assign(process.env, {
  LLM_BASE_URL: `${llm.url}/v1`, LLM_API_KEY: "test", LLM_MODEL: "stub-model", ASSISTANT_DAILY_TURNS: "40",
  LLM_PROVIDER_ORDER: "", LLM_FREE_MODELS: "", MODEL_CALLS_ENABLED: "true", AGNES_API_KEY: "", OPENCODE_API_KEY: "", OPENROUTER_API_KEY: "",
});

before(async () => {
  await sql`INSERT INTO users (id, email, password_hash) VALUES (${USER}, ${`${USER}@example.com`}, 'x')`;
});
after(async () => {
  await llm.close();
  await closeDb();
});

test("a resend after a timed-out turn is a new request; the same clientId is answered from its turn", async () => {
  const first = await intakeTurn(USER, `帮我跟踪机器人 ${T}`, { clientId: `a-${T}`, session: null });
  assert.equal(first.status, "done");
  // The call of that turn ends "unknown" (e.g. a 60s timeout after the request was sent).
  await sql`UPDATE receipts SET status = 'unknown' WHERE subject LIKE ${`user:${USER}:intake:%`}`;
  const hits = llm.hits();
  const again = await intakeTurn(USER, `帮我跟踪机器人 ${T}`, { clientId: `b-${T}`, session: null });
  assert.equal(again.status, "done", "再发一次 reaches the model");
  assert.equal(llm.hits(), hits + 1);
  const repeat = await intakeTurn(USER, `帮我跟踪机器人 ${T}`, { clientId: `b-${T}`, session: null });
  assert.equal(repeat.turnId, again.turnId);
  assert.equal(llm.hits(), hits + 1, "the same turn is not sent twice");
});
