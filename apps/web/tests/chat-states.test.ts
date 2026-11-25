// The web 对话's error states (P0): a signed-out reader is told to log in instead of waiting on
// 「正在想……」; an instance with no usable model says so with a way to 设置; a refused or lost send
// ends in an honest note and 「再发一次」, never an endless wait. All network is a fetch stub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { act } from "react";
import { ChatPage, CHAT_COPY, gateForStatus } from "../app/features/chat/chat.ts";
import { buttonByText, click, includes, mount, stubFetch, type, type StubHandler } from "./harness.ts";

const READY = { chat: "instance", reason: null, byokAvailable: true };

function handler(o: { thread?: number; status?: unknown; post?: () => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }> } = {}): StubHandler {
  return (url, init) => {
    if (url.startsWith("/api/me/chat") && (!init?.method || init.method === "GET")) return o.thread === 401 ? { status: 401, body: { code: "unauthorized" } } : { body: { messages: [] } };
    if (url === "/api/me/model-status") return o.thread === 401 ? { status: 401, body: {} } : { body: o.status ?? READY };
    if (url === "/api/projects") return { body: { projects: [] } };
    if (url === "/api/me/chat" && init?.method === "POST") return o.post ? o.post() : { body: { reply: "好的", status: "done", card: null, turnId: 1 } };
    return { status: 404, body: {} };
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 20) {
  await act(async () => { await sleep(ms); });
}

async function render(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const page = await mount();
  await page.render(createElement(ChatPage, { fetchImpl, ...extra }));
  await settle();
  return page;
}

function composer(scope: HTMLElement) {
  return { input: scope.querySelector("input") as HTMLInputElement, send: buttonByText(scope, CHAT_COPY.send) };
}

test("gateForStatus maps the model status to the composer gate", () => {
  assert.equal(gateForStatus({ chat: "instance" }), null);
  assert.equal(gateForStatus({ chat: "user-key" }), null);
  assert.deepEqual(gateForStatus({ chat: "none", reason: "not-configured", byokAvailable: true }), { kind: "no-model", text: CHAT_COPY.noModelKey, settings: true });
  assert.deepEqual(gateForStatus({ chat: "none", reason: "not-configured", byokAvailable: false }), { kind: "no-model", text: CHAT_COPY.noModelAdmin, settings: false });
  assert.deepEqual(gateForStatus({ chat: "none", reason: "model-calls-off", byokAvailable: true }), { kind: "no-model", text: CHAT_COPY.modelOff, settings: false });
});

test("signed out: the page asks to log in, the composer is closed, nothing is posted", async () => {
  const stub = stubFetch(handler({ thread: 401 }));
  const page = await render(stub.fetch);
  assert.ok(includes(page.container, CHAT_COPY.signedOut), page.container.textContent ?? "");
  assert.equal(buttonByText(page.container, CHAT_COPY.login).getAttribute("href"), "/login?next=%2Fchat");
  assert.equal(buttonByText(page.container, CHAT_COPY.register).getAttribute("href"), "/register");
  const c = composer(page.container);
  assert.equal(c.input.disabled, true);
  assert.equal(c.send.disabled, true);
  assert.equal(stub.count("/api/me/chat", "POST"), 0);
  assert.ok(!includes(page.container, CHAT_COPY.thinking));
  await page.teardown();
});

test("a send that comes back 401 (session ended) asks to log in instead of polling", async () => {
  const stub = stubFetch(handler({ post: () => ({ status: 401, body: { code: "unauthorized", detail: "请先登录。" } }) }));
  const page = await render(stub.fetch);
  const c = composer(page.container);
  await type(c.input, "帮我跟踪人形机器人");
  await click(c.send);
  await settle(50);
  assert.ok(includes(page.container, CHAT_COPY.signedOut), page.container.textContent ?? "");
  assert.ok(!includes(page.container, CHAT_COPY.thinking), "no endless 正在想");
  assert.ok(includes(page.container, CHAT_COPY.notSent));
  const threadPolls = stub.calls.filter((x) => x.url.startsWith("/api/me/chat?") || (x.url === "/api/me/chat" && !x.init?.method)).length;
  assert.ok(threadPolls <= 1, `no poll after a 401 (saw ${threadPolls})`);
  await page.teardown();
});

test("no usable model: a clear banner links to 设置 and the composer is closed", async () => {
  const stub = stubFetch(handler({ status: { chat: "none", reason: "not-configured", byokAvailable: true } }));
  const page = await render(stub.fetch);
  assert.ok(includes(page.container, CHAT_COPY.noModelKey), page.container.textContent ?? "");
  assert.equal(buttonByText(page.container, CHAT_COPY.toSettings).getAttribute("href"), "/settings#model-key");
  assert.equal(composer(page.container).send.disabled, true);
  await page.teardown();
});

test("a send refused with no_model (status went stale) shows the server's reason and the way to 设置", async () => {
  const detail = "还没有可用的模型：去「设置」填你自己的模型 Key（OpenAI 兼容，需要 Base URL），就能对话了。";
  let statusCalls = 0;
  const base = handler({ post: () => ({ status: 409, body: { code: "no_model", detail } }) });
  const stub = stubFetch((url, init) => {
    if (url === "/api/me/model-status") { statusCalls++; return { body: READY }; }
    return base(url, init);
  });
  const page = await render(stub.fetch);
  const c = composer(page.container);
  await type(c.input, "你好");
  await click(c.send);
  await settle(50);
  assert.ok(includes(page.container, detail), page.container.textContent ?? "");
  assert.ok(buttonByText(page.container, CHAT_COPY.toSettings));
  assert.ok(!includes(page.container, CHAT_COPY.thinking));
  assert.ok(statusCalls >= 2, "the status is read again");
  await page.teardown();
});

test("a 5xx answer ends at once with a note and 「再发一次」, which sends the same words again", async () => {
  let n = 0;
  const stub = stubFetch(handler({ post: () => (++n === 1 ? { status: 503, body: { code: "temporarily_unavailable", detail: "这次没能答复，请稍后再试。" } } : { body: { reply: "这次好了", status: "done", card: null, turnId: 2 } }) }));
  const page = await render(stub.fetch);
  const c = composer(page.container);
  await type(c.input, "帮我跟踪芯片");
  await click(c.send);
  await settle(50);
  assert.ok(includes(page.container, "这次没能答复，请稍后再试。"));
  assert.ok(!includes(page.container, CHAT_COPY.thinking));
  await click(buttonByText(page.container, CHAT_COPY.retry));
  await settle(50);
  assert.equal(stub.count("/api/me/chat", "POST"), 2);
  const bodies = stub.calls.filter((x) => x.init?.method === "POST").map((x) => JSON.parse(String(x.init?.body)) as { text: string; clientId: string });
  assert.equal(bodies[1]!.text, "帮我跟踪芯片");
  assert.notEqual(bodies[1]!.clientId, bodies[0]!.clientId, "a resend is a new turn");
  assert.ok(includes(page.container, "这次好了"));
  assert.ok(!includes(page.container, CHAT_COPY.notSent), "the failed line is replaced by the resent one");
  assert.equal((page.container.textContent ?? "").split("帮我跟踪芯片").length - 1, 1, "the words show once");
  await page.teardown();
});

test("a 429 says to slow down and offers 「再发一次」", async () => {
  const stub = stubFetch(handler({ post: () => ({ status: 429, body: { code: "rate_limited" } }) }));
  const page = await render(stub.fetch);
  const c = composer(page.container);
  await type(c.input, "hi");
  await click(c.send);
  await settle(50);
  assert.ok(includes(page.container, CHAT_COPY.tooMany));
  assert.ok(buttonByText(page.container, CHAT_COPY.retry));
  await page.teardown();
});

test("a send that hangs times out, polls a bounded window, then offers 「再发一次」", async () => {
  const stub = stubFetch((url, init) => {
    if (url === "/api/me/chat" && init?.method === "POST") {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return handler()(url, init);
  });
  const page = await render(stub.fetch, { postTimeoutMs: 60, pollWindowMs: 200, pollEveryMs: 40 });
  const c = composer(page.container);
  await type(c.input, "帮我跟踪光模块");
  await click(c.send);
  await settle(100);
  assert.ok(includes(page.container, CHAT_COPY.thinking), "waiting while the poll runs");
  await settle(400);
  assert.ok(!includes(page.container, CHAT_COPY.thinking), `the wait ends: ${page.container.textContent}`);
  assert.ok(includes(page.container, CHAT_COPY.notYet));
  assert.ok(buttonByText(page.container, CHAT_COPY.retry));
  await page.teardown();
});

test("a 「没想明白」 reply from the server is retryable", async () => {
  const stub = stubFetch(handler({ post: () => ({ body: { reply: "这次没想明白，再说一次试试？", status: "done", card: null, turnId: 3 } }) }));
  const page = await render(stub.fetch);
  const c = composer(page.container);
  await type(c.input, "随便");
  await click(c.send);
  await settle(50);
  assert.ok(buttonByText(page.container, CHAT_COPY.retry));
  await page.teardown();
});
