// The second newcomer trial (2026-11-17), the web side: the delete card's warning was Chinese in the
// English UI and lost its project name once applied; the runs page counted demo calls as paid; the
// Settings project rows ran together; a summary ran into its "Analysis" label; and the magazine card's
// source could only be copied, not opened.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { act, createElement } from "react";
import { LocaleProvider, messages } from "../app/lib/i18n.ts";
import { ChatPage } from "../app/features/chat/chat.ts";
import { TodayPage, type TodayView } from "../app/features/today/today-view.ts";
import { requestsHint } from "../app/features/admin/requests-hint.ts";
import { sourceLink } from "../app/features/magazine/view.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { CJK } from "./cjk-scan.ts";
import { mount, stubFetch } from "./harness.ts";

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const SERVER_WARNING = "删除后，这个项目的设置、关注的信源列表和项目评分会一起删掉，无法恢复。";

function deleteCard(before: { target: string; purpose: string } | null, status = "applied") {
  return {
    id: "00000000-0000-4000-8000-00000000000" + (before ? "1" : "2"), kind: "delete", projectId: "p1",
    before: before ? { ...before, focus: "", exclusions: "", sources: 3 } : null, payload: null,
    sources: { collecting: [], pending: [] }, warning: SERVER_WARNING, createdAt: null, status,
  };
}

async function chatWith(locale: "en" | "zh-CN", cards: unknown[]) {
  const messagesBody = cards.flatMap((card, i) => [
    { role: "user", text: "Delete the humanoid robots project", clientId: `c${i}`, createdAt: 1 + i * 2 },
    { role: "assistant", text: "Demo model: I put the proposal below together by fixed rules.", turnStatus: "done", replyTo: `c${i}`, createdAt: 2 + i * 2, card },
  ]);
  const stub = stubFetch((url, init) => {
    if (url.startsWith("/api/me/chat") && (!init?.method || init.method === "GET")) return { body: { messages: messagesBody } };
    if (url === "/api/me/model-status") return { body: { chat: "instance", via: "demo", reason: null, byokAvailable: true } };
    if (url === "/api/projects") return { body: { projects: [] } };
    return { status: 404, body: {} };
  });
  const page = await mount();
  await page.render(createElement(LocaleProvider, { locale, timeZone: "UTC" }, createElement(ChatPage, { fetchImpl: stub.fetch })));
  await settle();
  return page;
}

test("G4/G5 an applied delete card keeps its project name, and its warning is in the page's language", async () => {
  const page = await chatWith("en", [deleteCard({ target: "humanoid robots", purpose: "What important changes will happen in humanoid robots?" })]);
  const text = page.container.textContent ?? "";
  assert.ok(text.includes("Delete 'humanoid robots'"), text);
  assert.ok(text.includes("What important changes will happen in humanoid robots?"), "the target line is not '—'");
  assert.ok(text.includes(messages("en").chat.deleteWarning), "the English warning");
  assert.doesNotMatch(text, CJK, "no Chinese in the English chat");
  await page.teardown();

  const zh = await chatWith("zh-CN", [deleteCard({ target: "人形机器人", purpose: "人形机器人接下来会有哪些重要变化？" })]);
  assert.ok((zh.container.textContent ?? "").includes(messages("zh-CN").chat.deleteWarning));
  await zh.teardown();
});

test("G4 a delete card from before the fix (no snapshot) says 'Delete this project', never Delete ''", async () => {
  const page = await chatWith("en", [deleteCard(null)]);
  const text = page.container.textContent ?? "";
  assert.ok(text.includes("Delete this project"), text);
  assert.ok(!text.includes("Delete ''"), text);
  await page.teardown();
});

test("G5 the runs page tells paid, free and demo calls apart", () => {
  const num = (n: number) => String(n);
  const en = messages("en").adminRuns.runs;
  assert.equal(requestsHint({ counts: { completed: 19 }, kinds: { paid: 0, free: 0, demo: 19 } }, en, num), "0 paid requests in 7 days · 19 demo-model (no cost)");
  assert.equal(requestsHint({ counts: { completed: 5 }, kinds: { paid: 2, free: 3, demo: 0 } }, en, num), "2 paid requests in 7 days · 3 free-model");
  const zh = messages("zh-CN").adminRuns.runs;
  assert.equal(requestsHint({ counts: {}, kinds: { paid: 0, free: 0, demo: 19 } }, zh, num), "7 天 0 次付费请求 · 19 次演示模型（不花钱）");
  // An older API without kinds: everything counts as paid, as before.
  assert.equal(requestsHint({ counts: { completed: 4, failed: 1 } }, en, num), "5 paid requests in 7 days");
});

test("G9 Settings lists each project on its own row: name left, 'Project Today' right", () => {
  const css = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
  const rule = /\.settings-proj-row \{([^}]+)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /display: flex/);
  assert.match(rule, /justify-content: space-between/);
  assert.match(css, /\.settings-projs \{ display: flex; flex-direction: column; \}/);
});

test("G10 a project card's summary is separated from its 'Analysis' label", async () => {
  const view: TodayView = {
    project: { id: "project:x:y:12345678", slug: "pabcdefabcdef", target: "Robots", purpose: "Track" },
    window: { since: "2026-10-20T04:00:00.000Z", until: "2026-10-21T04:00:00.000Z" },
    checkpoint: { readThrough: null, ackSeq: 0, receiptId: null },
    snapshot: { id: "brief-snapshot-v1:0123456789abcdef0123456789abcdef", ackSeq: 0, acknowledgementAllowed: true },
    sources: { linked: 1, active: 1 }, coverage: { satisfied: true, sources: [] }, unassessed: 0,
    result: "updates-available", emptyState: null, cardCount: 3, quietDay: false, awaitingAnalysis: 0, notice: "",
    items: [{ id: "a1", title: "T", originalTitle: null, summary: "This is a demo story.", url: "https://example.org/1", source: { id: "s1", name: "S" }, publishedAt: null, listedAt: "2026-10-21T02:00:00.000Z", selected: false }],
  };
  const stub = stubFetch((url) => (url.startsWith("/api/projects/") ? { body: view } : { status: 404, body: {} }));
  const page = await mount();
  await page.render(createElement(LocaleProvider, { locale: "en", timeZone: "UTC" }, createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch })));
  await settle();
  const text = page.container.textContent ?? "";
  assert.ok(text.includes("Analysis This is a demo story."), text);
  await page.teardown();
});

test("the magazine card's source domain opens the original in a new tab (web addresses only)", () => {
  const html = renderToStaticMarkup(sourceLink("https://arxiv.org/abs/1", "arxiv.org", "Open the original"));
  assert.match(html, /<a [^>]*href="https:\/\/arxiv.org\/abs\/1"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.doesNotMatch(renderToStaticMarkup(sourceLink("javascript:alert(1)", "x", "x")), /<a /);
});
