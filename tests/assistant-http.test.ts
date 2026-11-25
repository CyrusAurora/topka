// The web 对话 door (web-b1): the project assistant an external sync client reaches now has
// a session-cookie HTTP API (/api/me/chat*). The thread lists the user's recent turns with their
// cards, a message runs one Socratic intake turn (question with options → summarized question → card),
// change/delete sentences the one-shot assistant, and confirm/cancel/delete-proposal apply nothing
// until 确认. The model is a stub that answers by the intake's mode; the rest covers the route wiring
// (auth, validation, unknown ids) without touching the model.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";
import { createProject } from "@topka/backend/projects/create-project";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SRC = `chat-src-${T}`;
const PASSWORD = `${T}-long-enough`;
const app = await buildApp();

// The stub answers the assistant's schema: one create proposal, then plain replies.
const asked: string[] = [];
const llm = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  const user = body.messages[body.messages.length - 1]!.content;
  asked.push(user);
  const say = (o: unknown) => ({ id: "x", model: "stub", choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
  // The intake: question first, a summary once a question is answered, the card in card mode.
  if (user.includes("【模式】")) {
    if (user.startsWith("【模式】card")) {
      return say({ kind: "card", judgement: "值得跟踪。", reasons: ["订单在变多"], next: "先看最近的订单公告。", card: { target: `机器人 ${T}`, purpose: "量产能否兑现", focus: "订单", exclusions: "", variables: ["交付量"], sourceIds: [SRC, "made-up"] } });
    }
    if (/A1：(?!（未答）)/.test(user)) {
      return say({ kind: "summary", update: "明白，你关心量产。", summary: { ask: "建个项目", problem: "量产能否兑现", facts: ["关注量产"], assumptions: [], variables: ["交付量"], question: "未来一年能否千台交付？" } });
    }
    return say({ kind: "question", analysis: { vague: ["跟踪"] }, update: "先理解为你想跟踪机器人。", question: "你最关心哪方面？", options: ["量产", "融资", "其他"] });
  }
  // Only the latest user line counts — history also embeds earlier「建个」turns.
  const latest = user.includes("【用户这次说】") ? user.slice(user.lastIndexOf("【用户这次说】")) : user;
  if (latest.includes("建个")) return say({ action: "propose_create", projectRef: null, reply: "整理成了提议，确认后才会生效。", proposal: { target: `机器人 ${T}`, purpose: "跟踪", focus: "", exclusions: "", sourceIds: [SRC] } });
  return say({ action: "reply", projectRef: null, reply: "你好。", proposal: null });
});
Object.assign(process.env, {
  LLM_BASE_URL: `${llm.url}/v1`, LLM_API_KEY: "test", LLM_MODEL: "stub-model", ASSISTANT_DAILY_TURNS: "40", CHAT_PER_MINUTE: "0", // the burst guard has its own test (rate-limits)
  // Local shells often inherit a provider chain; pin the stub path for this file.
  LLM_PROVIDER_ORDER: "", LLM_FREE_MODELS: "", MODEL_CALLS_ENABLED: "true",
  AGNES_API_KEY: "", OPENCODE_API_KEY: "", OPENROUTER_API_KEY: "",
});

let token = "";
let userId = "";
const cookie = () => `${SESSION_COOKIE}=${token}`;

async function post(url: string, body: unknown, cookieHeader?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    payload: JSON.stringify(body),
  });
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES (${SRC}, ${`Chat ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `test ${T}` })).code;
  const r = await registerWithInvite({ code, email: `chat-${T}@example.com`, password: PASSWORD, userAgent: "test", ip: "203.0.113.50" });
  userId = r.user.id;
  token = r.token;
});

after(async () => {
  await llm.close();
  await app.close();
  await closeDb();
});

test("every chat route requires the session cookie and answers 401「请先登录。」", async () => {
  const get = await app.inject({ method: "GET", url: "/api/me/chat" });
  assert.deepEqual([get.statusCode, get.json().code, get.json().detail], [401, "unauthorized", "请先登录。"], get.body);
  for (const [url, body] of [
    ["/api/me/chat", { text: `你好 ${T}` }],
    ["/api/me/chat/confirm", { proposalId: "00000000-0000-0000-0000-000000000000" }],
    ["/api/me/chat/cancel", { proposalId: "00000000-0000-0000-0000-000000000000" }],
    ["/api/me/chat/delete-proposal", { projectId: "x" }],
  ] as Array<[string, unknown]>) {
    const res = await post(url, body);
    assert.equal(res.statusCode, 401, `${url} without a session: ${res.body}`);
    assert.equal(res.json().detail, "请先登录。");
  }
});

/** One intake from ask to card: question (options + 其他) → answer → summarized question → 对 → card. */
async function intakeCard(prefix: string) {
  await post("/api/me/chat", { text: "重新开始" }, cookie());
  const q = (await post("/api/me/chat", { text: `帮我建个跟踪项目 ${T}`, clientId: `${prefix}-1` }, cookie())).json();
  assert.equal(q.kind, "question", JSON.stringify(q));
  const s = (await post("/api/me/chat", { text: q.chips[0], clientId: `${prefix}-2` }, cookie())).json();
  assert.equal(s.kind, "confirm", JSON.stringify(s));
  const c = (await post("/api/me/chat", { text: s.chips[0], clientId: `${prefix}-3` }, cookie())).json();
  assert.equal(c.kind, "card", JSON.stringify(c));
  return c as { reply: string; card: { id: string; kind: string; payload: { target: string; sourceIds: string[]; focus: string; intake: { question: string; variables: string[]; judgement: string } } } };
}

test("POST /api/me/chat without text is 400; a new ask runs the Socratic intake: one question with options, a summary to confirm, then a card", async () => {
  const empty = await post("/api/me/chat", { text: "" }, cookie());
  assert.deepEqual([empty.statusCode, empty.json().code], [400, "text_required"], empty.body);

  const turn = await post("/api/me/chat", { text: `帮我建个跟踪项目 ${T}`, clientId: `w-${T}-1` }, cookie());
  assert.equal(turn.statusCode, 200, turn.body);
  const body = turn.json() as { reply: string; status: string; card: unknown; turnId: number; kind: string; chips: string[]; step: number };
  assert.equal(body.status, "done");
  assert.equal(body.card, null, "no card before the question is pinned down");
  assert.equal(body.kind, "question");
  assert.deepEqual(body.chips, ["量产", "融资", "其他"], "the model's options, 「其他」 once, last");
  assert.equal(body.step, 1);
  assert.match(body.reply, /^先理解为你想跟踪机器人。\n你最关心哪方面？$/, "the update line comes before the question");
  assert.equal(typeof body.turnId, "number");
  assert.ok(asked.some((u) => u.includes("帮我建个跟踪项目")), "the model saw the user's line");

  const summary = (await post("/api/me/chat", { text: "量产", clientId: `w-${T}-1b` }, cookie())).json();
  assert.equal(summary.kind, "confirm");
  assert.equal(summary.intake.question, "未来一年能否千台交付？");
  assert.deepEqual(summary.chips, ["对，就按这个", "不太对，我来改"]);
  assert.equal(summary.card, null, "the card only comes after the question is confirmed");

  const card = (await post("/api/me/chat", { text: "对，就按这个", clientId: `w-${T}-1c` }, cookie())).json();
  assert.equal(card.kind, "card");
  assert.equal(card.card.kind, "create");
  assert.deepEqual(card.card.payload.sourceIds, [SRC], "made-up source ids are dropped");
  assert.equal(card.card.payload.intake.question, "未来一年能否千台交付？");
  assert.deepEqual(card.card.payload.intake.variables, ["交付量"]);
  assert.match(card.card.payload.focus, /交付量/, "the key variables are what the project watches");
  assert.match(card.reply, /确认后才会创建/);

  // A repeat of the same clientId is answered from the first turn, without a model call.
  const calls = asked.length;
  const again = (await post("/api/me/chat", { text: "对，就按这个", clientId: `w-${T}-1c` }, cookie())).json();
  assert.equal(again.card.id, card.card.id);
  assert.equal(asked.length, calls);

  // Anything said after the card revises it; 「重新开始」 starts over without a model call.
  const n = asked.length;
  const restart = (await post("/api/me/chat", { text: "重新开始" }, cookie())).json();
  assert.equal(restart.kind, "note");
  assert.equal(asked.length, n, "restart needs no model");
  const plain = await post("/api/me/chat", { text: `你好 ${T}` }, cookie());
  assert.equal(plain.statusCode, 200, plain.body);
  assert.equal((plain.json() as { card: unknown }).card, null);
  assert.equal(asked.length, n + 1, "one call per turn");
  await post("/api/me/chat", { text: "重新开始" }, cookie());
});

test("修改 / 删除 sentences still go to the one-shot assistant", async () => {
  const r = (await post("/api/me/chat", { text: "修改机器人：建个新的关注点", clientId: `w-${T}-m` }, cookie())).json();
  assert.equal(r.kind, undefined, "a legacy turn has no intake kind");
  assert.ok(asked.at(-1)!.includes("【用户这次说】"), "the legacy prompt answered");
  await post("/api/me/chat", { text: "重新开始" }, cookie());
});

test("GET /api/me/chat answers the thread newest-first; a card rides on its turn, chips and the summary on theirs", async () => {
  await intakeCard(`w-${T}-2`);
  const thread = await app.inject({ method: "GET", url: "/api/me/chat", headers: { cookie: cookie() } });
  assert.equal(thread.statusCode, 200, thread.body);
  const messages = (thread.json() as { messages: Array<{ role: string; text: string; clientId?: string; replyTo?: string; turnStatus?: string; card?: { id: string; kind: string } | null }> }).messages;
  assert.ok(messages.length >= 4, "both turns, user and assistant lines: " + JSON.stringify(messages));
  const card = messages.find((m) => m.card)?.card!;
  assert.equal(card.kind, "create");
  const reply = messages.find((m) => m.role === "assistant" && m.replyTo === `w-${T}-2-3`)!;
  assert.equal(reply.turnStatus, "done");
  assert.ok(reply.card, "the create card is attached to its answer");
  const question = messages.find((m) => m.role === "assistant" && m.replyTo === `w-${T}-2-1`) as { chips?: string[]; kind?: string };
  assert.deepEqual([question.kind, question.chips?.at(-1)], ["question", "其他"]);
  const confirm = messages.find((m) => m.role === "assistant" && m.replyTo === `w-${T}-2-2`) as { intake?: { question: string } };
  assert.equal(confirm.intake?.question, "未来一年能否千台交付？");
});

test("confirm applies the card once; a repeat finds it applied", async () => {
  const cardId = (await intakeCard(`w-${T}-3`)).card.id;
  const before = (await sql`SELECT count(*)::int AS n FROM tracking_projects WHERE owner_id = ${userId}`)[0]!.n;
  const ok = await post("/api/me/chat/confirm", { proposalId: cardId }, cookie());
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual([ok.json().ok, ok.json().kind], [true, "create"], ok.body);
  assert.equal((await sql`SELECT count(*)::int AS n FROM tracking_projects WHERE owner_id = ${userId}`)[0]!.n, before + 1, "the card created its project");
  const again = await post("/api/me/chat/confirm", { proposalId: cardId }, cookie());
  assert.equal(again.json().ok, false, "the second tap does not create again");
  assert.match(again.json().message, /已经确认过/);
  // The intake is finished: the next sentence starts a new one (a question, not a revision of the card).
  const next = (await post("/api/me/chat", { text: `帮我建个跟踪项目 ${T}`, clientId: `w-${T}-3n` }, cookie())).json();
  assert.equal(next.kind, "question");
  await post("/api/me/chat", { text: "重新开始" }, cookie());
});

test("confirm/cancel with a malformed or unknown id refuses; cancel closes the open card", async () => {
  const bad = await post("/api/me/chat/confirm", { proposalId: "nope" }, cookie());
  assert.deepEqual([bad.statusCode, bad.json().code], [400, "proposal_required"], bad.body);
  const ghost = await post("/api/me/chat/confirm", { proposalId: "00000000-0000-0000-0000-000000000000" }, cookie());
  assert.equal(ghost.statusCode, 404, ghost.body);

  const open = (await intakeCard(`w-${T}-4`)).card.id;
  const cancel = await post("/api/me/chat/cancel", { proposalId: open }, cookie());
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.deepEqual([cancel.json().ok, cancel.json().state], [true, "cancelled"], cancel.body);
  const closed = await post("/api/me/chat/confirm", { proposalId: open }, cookie());
  assert.equal(closed.json().ok, false, "a cancelled card will not apply");
});

test("delete-proposal opens the red card for one's own project and 404s anyone else's", async () => {
  const { project } = await createProject({ ownerId: userId, target: `要删的 ${T}`, purpose: "目的", sources: [] });
  const res = await post("/api/me/chat/delete-proposal", { projectId: project.id }, cookie());
  assert.equal(res.statusCode, 200, res.body);
  const card = (res.json() as { card: { kind: string; projectId: string; warning: string } }).card;
  assert.deepEqual([card.kind, card.projectId], ["delete", project.id]);
  assert.match(card.warning, /无法恢复/);
  // A stranger's project: 404, existence never leaks.
  const stranger = (await registerWithInvite({
    code: (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `test ${T}` })).code,
    email: `stranger-${T}@example.com`,
    password: PASSWORD,
  })).token;
  const denied = await post("/api/me/chat/delete-proposal", { projectId: project.id }, `${SESSION_COOKIE}=${stranger}`);
  assert.equal(denied.statusCode, 404, denied.body);
});
