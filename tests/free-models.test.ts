// Free-only guard: a call goes only to a candidate whose catalog price is zero right now, never through
// a router or a paid fallback; with no free candidate the work waits (NoFreeModelError is a budget
// wait), and a billed or substituted answer benches the model.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { z } from "zod";

const T = tag();
const FREE = { prompt: "0", completion: "0", request: "0", image: "0", input_cache_read: "0", input_cache_write: "0" };
let catalog: Array<{ id: string; pricing: Record<string, string> }> = [];
let chat: (body: Record<string, unknown>) => unknown = () => null;
let remaining = 500;
const bodies: Array<Record<string, unknown>> = [];
const provider = await stub((_hit, req) => {
  if (req.url.endsWith("/models")) return { data: catalog };
  if (req.url.endsWith("/key")) return { data: { free_model_daily_requests: { used: 1000 - remaining, limit: 1000, remaining } } };
  const body = JSON.parse(req.body) as Record<string, unknown>;
  bodies.push(body);
  return chat(body);
});
const answer = (model: string, cost = 0) => ({ id: `gen-${T}`, model, choices: [{ message: { content: JSON.stringify({ ok: true }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost } });

Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "ignored-when-guarded", MODEL_CALLS_ENABLED: "true",
  LLM_FREE_MODELS: "first/model:free, second/model:free", LLM_FREE_CATALOG_URL: `${provider.url}/models`, LLM_FREE_QUOTA_URL: `${provider.url}/key`,
  LLM_EXTRA_JSON: JSON.stringify({ models: ["paid/model"], route: "fallback", reasoning: { effort: "low" } }),
});
for (const name of Object.keys(process.env)) if (/_MODEL$/.test(name) && !["LLM_MODEL", "EMBEDDING_MODEL"].includes(name)) delete process.env[name];

const { chatJson } = await import("@topka/backend/providers/llm");
const { BudgetExceededError, paidRequest, ProviderRejectedError, secondsToUtcMidnight } = await import("@topka/backend/providers/receipts");
const guard = await import("@topka/backend/providers/free-models");
const { closeDb, sql } = await import("@topka/backend/db");

const call = (n: string) => chatJson({ model: "default", purpose: "free_guard_test", subject: `free:${T}:${n}`, promptVersion: "t1", system: "s", user: `u ${T} ${n}`, schema: z.object({ ok: z.boolean() }) });

beforeEach(() => {
  guard.resetFreeGuard();
  remaining = 500;
  bodies.length = 0;
});
after(async () => {
  await provider.close();
  await closeDb();
});

test("only all-zero pricing on a pinned :free id counts as free", () => {
  const cat = (pricing: Record<string, string>, id = "a/b:free") => ({ data: [{ id, pricing }] });
  assert.equal(guard.openRouterPriceCheck("a/b:free", cat(FREE)).free, true);
  assert.equal(guard.openRouterPriceCheck("a/b:free", cat({ ...FREE, input_cache_read: "0.0000001" })).free, false);
  assert.equal(guard.openRouterPriceCheck("a/b:free", cat({ ...FREE, request: "0.01" })).free, false);
  assert.equal(guard.openRouterPriceCheck("a/b:free", cat({ prompt: "0" })).free, false, "completion price missing");
  assert.equal(guard.openRouterPriceCheck("a/b:free", { data: [] }).free, false, "gone from the catalog");
  assert.equal(guard.openRouterPriceCheck("a/b", cat(FREE, "a/b")).free, false, "not a :free variant");
  assert.equal(guard.openRouterPriceCheck("openrouter/free", cat(FREE, "openrouter/free")).free, false, "router");
  assert.equal(guard.openRouterPriceCheck("openrouter/auto", cat(FREE, "openrouter/auto")).free, false, "auto router");
});

test("a SiliconFlow model is free only when its list price and every price item are 0", () => {
  // The pricing page's flight data, split mid-row across two chunks as the real page does.
  const rows = [
    `1:{"modelName":"BAAI/bge-m3","price":"0","status":"normal","pricing":"$2"}`,
    `3:{"price":"0","specification":"prompt"}`, `4:{"price":"0","specification":"completion"}`, `2:["$3","$4"]`,
    `5:{"modelName":"Pro/BAAI/bge-m3","price":"0.07","status":"normal","pricing":"$6"}`, `7:{"price":"0.07","specification":"prompt"}`, `6:["$7"]`,
    `8:{"modelName":"cheap/one","price":"0","status":"normal","pricing":"$9"}`, `a:{"price":"0.01","specification":"prompt"}`, `9:["$a"]`,
  ].join("\n");
  const cut = rows.indexOf(`"price":"0.07"`);
  const html = [rows.slice(0, cut), rows.slice(cut)].map((c) => `<script>self.__next_f.push([1,${JSON.stringify(c)}])</script>`).join("");
  const flight = guard.siliconFlowFlight(html);
  assert.equal(guard.siliconFlowPriceCheck("BAAI/bge-m3", flight).free, true);
  assert.equal(guard.siliconFlowPriceCheck("Pro/BAAI/bge-m3", flight).free, false);
  assert.equal(guard.siliconFlowPriceCheck("cheap/one", flight).free, false, "a priced item");
  assert.equal(guard.siliconFlowPriceCheck("missing/one", flight).free, false);
});

test("calls go to the first free candidate, pinned, with a zero max price and no routing fields", async () => {
  catalog = [{ id: "first/model:free", pricing: FREE }, { id: "second/model:free", pricing: FREE }];
  chat = (b) => answer(String(b.model));
  await call("pinned");
  const b = bodies.at(-1)!;
  assert.equal(b.model, "first/model:free");
  assert.equal(b.models, undefined);
  assert.equal(b.route, undefined);
  assert.deepEqual((b.provider as { max_price: unknown }).max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
  assert.deepEqual(b.reasoning, { effort: "low" }, "other extra fields still go through");
});

test("a candidate that turned paid is skipped, a rate-limited one sits out", async () => {
  catalog = [{ id: "first/model:free", pricing: { ...FREE, completion: "0.000002" } }, { id: "second/model:free", pricing: FREE }];
  chat = (b) => answer(String(b.model));
  await call("paid-first");
  assert.deepEqual(bodies.map((b) => b.model), ["second/model:free"]);

  guard.resetFreeGuard();
  bodies.length = 0;
  catalog = [{ id: "first/model:free", pricing: FREE }, { id: "second/model:free", pricing: FREE }];
  chat = (b) => (b.model === "first/model:free" ? new Reply(429, { error: { message: "rate-limited upstream" } }) : answer(String(b.model)));
  await call("limited");
  assert.deepEqual(bodies.map((b) => b.model), ["first/model:free", "second/model:free"]);
  await call("limited-again");
  assert.equal(bodies.at(-1)!.model, "second/model:free", "the limited model is still benched");
});

test("no free candidate: the call waits (a budget wait), nothing is sent", async () => {
  catalog = [{ id: "first/model:free", pricing: { ...FREE, prompt: "0.1" } }];
  chat = (b) => answer(String(b.model));
  await assert.rejects(call("none"), (e: unknown) => e instanceof guard.NoFreeModelError && e instanceof BudgetExceededError && /NO_FREE_MODEL/.test((e as Error).message));
  assert.equal(bodies.length, 0);
  // Every free candidate rate-limited: the same wait.
  guard.resetFreeGuard();
  catalog = [{ id: "first/model:free", pricing: FREE }, { id: "second/model:free", pricing: FREE }];
  chat = () => new Reply(429, { error: { message: "busy" } });
  await assert.rejects(call("all-limited"), (e: unknown) => e instanceof guard.NoFreeModelError);
});

test("unusable output moves on to the next candidate; junk while better ones are rate-limited waits", async () => {
  const junk = (model: string) => ({ id: `gen-${T}`, model, choices: [{ message: { content: "Sure! Here is the analysis you asked for." } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } });
  catalog = [{ id: "first/model:free", pricing: FREE }, { id: "second/model:free", pricing: FREE }];
  // The first answers junk: the same call goes on to the second and succeeds.
  chat = (b) => (b.model === "first/model:free" ? junk(String(b.model)) : answer(String(b.model)));
  const r = await call("junk-first");
  assert.deepEqual(r.data, { ok: true });
  assert.deepEqual(bodies.map((b) => b.model), ["first/model:free", "second/model:free"]);
  // A second junk answer in a row benches it: the next call goes straight to the second.
  await call("junk-again");
  bodies.length = 0;
  await call("after-junk");
  assert.deepEqual(bodies.map((b) => b.model), ["second/model:free"], "the junk model sits out");

  // The 08:00 rush: the good model is rate-limited and the one left answers junk. The call waits
  // (a budget wait, the article keeps its attempts) instead of failing on the junk.
  guard.resetFreeGuard();
  bodies.length = 0;
  chat = (b) => (b.model === "first/model:free" ? new Reply(429, { error: { message: "busy" } }) : junk(String(b.model)));
  await assert.rejects(call("rush"), (e: unknown) => e instanceof guard.NoFreeModelError && e instanceof BudgetExceededError);
  assert.deepEqual(bodies.map((b) => b.model), ["first/model:free", "second/model:free"]);

  // Every candidate answers junk and none is sitting out: a real unusable answer, the attempt counts.
  guard.resetFreeGuard();
  chat = (b) => junk(String(b.model));
  await assert.rejects(call("all-junk"), (e: unknown) => !(e instanceof BudgetExceededError) && /unusable output/.test((e as Error).message));
});

test("a model refused again and again sits out longer each time; an answer resets it", () => {
  assert.equal(guard.noteRateLimited("llm", "x/y:free"), 60);
  assert.equal(guard.noteRateLimited("llm", "x/y:free"), 120);
  assert.equal(guard.noteRateLimited("llm", "x/y:free"), 240);
  for (let i = 0; i < 10; i++) guard.noteRateLimited("llm", "x/y:free");
  assert.equal(guard.noteRateLimited("llm", "x/y:free"), guard.RATE_LIMIT_MAX_SECONDS, "capped at 30 min");
  guard.noteUsable("llm", "x/y:free");
  assert.equal(guard.noteRateLimited("llm", "x/y:free"), 60, "back to a minute after an answer");
  assert.equal(guard.noteRateLimited("llm", "z/w:free", 600), 600, "a longer Retry-After wins");
});

test("a billed or substituted answer benches the model", async () => {
  catalog = [{ id: "first/model:free", pricing: FREE }, { id: "second/model:free", pricing: FREE }];
  chat = (b) => (b.model === "first/model:free" ? answer("first/model:free", 0.0004) : answer(String(b.model)));
  await call("billed");
  await call("after-billed");
  assert.deepEqual(bodies.map((b) => b.model), ["first/model:free", "second/model:free"]);
  assert.equal(guard.auditFreeResponse("llm", "a:free", { model: "a", usage: { cost: 0 } }), "answered by a, not a:free");
  assert.equal(guard.auditFreeResponse("llm", "a:free", { model: "a:free", usage: { cost: 0 } }), null);
});

test("OpenRouter's own remaining count is the last word: near zero, calls wait for 00:00 UTC", async () => {
  catalog = [{ id: "first/model:free", pricing: FREE }];
  chat = (b) => answer(String(b.model));
  remaining = 15;
  await assert.rejects(call("quota"), (e: unknown) => e instanceof BudgetExceededError && /OpenRouter free requests today: 15 left/.test((e as Error).message) && (e as InstanceType<typeof BudgetExceededError>).retryAfterSeconds <= 86_400);
  assert.equal(bodies.length, 0);
  guard.resetFreeGuard();
  remaining = 400;
  await call("quota-ok");
  assert.equal(bodies.length, 1);
});

test("a 'utc' daily budget counts calls since 00:00 UTC, not the last 24 hours", async () => {
  const service = `utc-test-${T}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day, day_window) VALUES (${service}, 100, 100, 2, 'utc')`;
  const send = (n: number) => paidRequest({ service, purpose: "utc_test", subject: `utc:${T}:${n}`, identity: { n, T } }, async () => ({ response: { ok: true }, usage: null, cost: null }));
  await send(1);
  await send(2);
  await assert.rejects(send(3), (e: unknown) => e instanceof BudgetExceededError && /UTC day/.test((e as Error).message));
  // Yesterday (UTC) no longer counts, even within the last 24 hours.
  await sql`UPDATE receipt_attempts SET started_at = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 minute' WHERE service = ${service}`;
  await send(3);
  const at = new Date("2026-10-21T23:59:00Z");
  assert.equal(secondsToUtcMidnight(at), 60);
  assert.equal(secondsToUtcMidnight(new Date("2026-10-21T00:00:00Z")), 86_400);
});

test("a request the provider refused with 429 is left out of the day budget, not out of the minute window", async () => {
  const service = `utc429-test-${T}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day, day_window) VALUES (${service}, 6, 100, 2, 'utc')`;
  let n = 0;
  const send = (refuse: boolean) => paidRequest({ service, purpose: "utc_test", subject: `utc429:${T}:${++n}`, identity: { n, T } }, async () => {
    if (refuse) throw new ProviderRejectedError('HTTP 429: {"error":{"message":"Provider returned error","code":429}}', 429, true);
    return { response: { ok: true }, usage: null, cost: null };
  });
  // Three upstream refusals: the day quota (2) is untouched, as on OpenRouter's own counter.
  for (let i = 0; i < 3; i++) await assert.rejects(send(true), (e: unknown) => e instanceof ProviderRejectedError);
  await send(false);
  await send(false);
  await assert.rejects(send(false), (e: unknown) => e instanceof BudgetExceededError && /UTC day/.test((e as Error).message));
  // The minute window still counts every request sent, refusals included.
  await sql`UPDATE budgets SET per_day = 100 WHERE service = ${service}`;
  await send(false);
  await assert.rejects(send(false), (e: unknown) => e instanceof BudgetExceededError && /minute/.test((e as Error).message));
  // Any other failure still counts against the day.
  const other = `utcfail-test-${T}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day, day_window) VALUES (${other}, 100, 100, 1, 'utc')`;
  await assert.rejects(paidRequest({ service: other, purpose: "utc_test", subject: `utcfail:${T}:1`, identity: { T, k: 1 } }, async () => { throw new ProviderRejectedError("HTTP 400: bad", 400, false); }), (e: unknown) => e instanceof ProviderRejectedError);
  await assert.rejects(paidRequest({ service: other, purpose: "utc_test", subject: `utcfail:${T}:2`, identity: { T, k: 2 } }, async () => ({ response: { ok: true }, usage: null, cost: null })), (e: unknown) => e instanceof BudgetExceededError);
});

test("a bench runs on the wall clock: once it is over (box suspended or not) the model is asked again", async () => {
  catalog = [{ id: "first/model:free", pricing: FREE }];
  let refuse = true;
  chat = (b) => (refuse ? new Reply(429, { error: { message: "Provider returned error", code: 429 } }) : answer(String(b.model)));
  const realNow = Date.now.bind(Date);
  let skew = 0;
  const clock = mock.method(Date, "now", () => realNow() + skew);
  try {
    await assert.rejects(call("bench-1"), (e: unknown) => e instanceof guard.NoFreeModelError);
    assert.equal(bodies.length, 1);
    // Still benched: nothing is sent.
    await assert.rejects(call("bench-2"), (e: unknown) => e instanceof BudgetExceededError);
    assert.equal(bodies.length, 1);
    // The wall clock moves past the 60 s bench (as it does across a suspend, with no timer running).
    skew = 61_000;
    refuse = false;
    const out = await call("bench-3");
    assert.equal(out.data.ok, true);
    assert.deepEqual(bodies.map((b) => b.model), ["first/model:free", "first/model:free"]);
    // The streak was reset by the answer: the next refusal benches for a minute again.
    assert.equal(guard.noteRateLimited("llm", "first/model:free"), 60);
  } finally {
    clock.mock.restore();
  }
});
