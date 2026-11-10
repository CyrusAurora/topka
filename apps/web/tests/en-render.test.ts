// The English UI renders no Chinese: every page component, in each state a reader can reach, is
// mounted under the en locale and its text and accessible attributes are scanned for CJK. The
// fixtures are English, and the API's own fixed Chinese copy (a 429 detail, the issue notice, the
// empty-state text, the intake's 「其他」 chip) is fed in on purpose: an English page must not show it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, type ReactElement } from "react";
import { LocaleProvider, messages, problemMessage } from "../app/lib/i18n.ts";
import { CJK } from "./cjk-scan.ts";
import { MagazineToday } from "../app/features/magazine/today.ts";
import { ArchivePage } from "../app/features/magazine/archive.ts";
import { TodayPage } from "../app/features/today/today-view.ts";
import { ChatPage } from "../app/features/chat/chat.ts";
import { SettingsPage } from "../app/features/settings/settings.ts";
import { GuidedCreation } from "../app/features/projects/guided-creation.ts";
import { ProjectsOverview } from "../app/features/projects/overview.ts";
import { buttonByText, click, mount, stubFetch, type StubHandler } from "./harness.ts";

const ATTRS = ["aria-label", "placeholder", "title", "alt"];
function chineseIn(root: HTMLElement): string[] {
  const hits: string[] = [];
  // The one allowed exception: the language switch names Chinese in Chinese.
  const text = (root.textContent ?? "").replaceAll(messages("en").settings.localeZh, "");
  if (CJK.test(text)) hits.push(`text: ${text.slice(Math.max(0, text.search(CJK) - 40), text.search(CJK) + 40)}`);
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && CJK.test(v)) hits.push(`${el.tagName.toLowerCase()}[${a}]: ${v}`);
    }
  }
  return hits;
}

async function renderEn(node: ReactElement) {
  const page = await mount();
  await page.render(createElement(LocaleProvider, { locale: "en", timeZone: "America/New_York" }, node));
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return page;
}

async function expectEnglish(label: string, node: ReactElement, then?: (root: HTMLElement) => Promise<void>) {
  const page = await renderEn(node);
  try {
    assert.ok((page.container.textContent ?? "").trim().length > 0, `${label}: rendered something`);
    if (then) await then(page.container);
    assert.deepEqual(chineseIn(page.container), [], `${label}: no Chinese in the English UI`);
  } finally {
    await page.teardown();
  }
}

const item = (n: number) => ({
  id: `a${n}`, position: n, title_a: `Lab ships model ${n}`, title_b: "", core_a: "Faster and cheaper", core_b: "",
  summary: `Summary ${n}`, tag: "Models", source: "The Decoder", url: `https://example.org/${n}`, score: 80,
  project: { id: "p1", slug: "models", target: "AI models" },
  publishedAt: "2026-10-26T12:00:00.000Z", listedAt: "2026-10-27T00:00:00.000Z", hasCopy: true, overBudget: false,
});
const ISSUE = {
  projects: [{ id: "p1", slug: "models", target: "AI models" }, { id: "p2", slug: "robots", target: "Robots" }],
  issue: { date: "2026-10-27", no: 12, fixedAt: "2026-10-27T00:00:00.000Z", hero: true, ready: true, items: [item(1), item(2), item(3)] },
  opened: [],
  archive: [{ date: "2026-10-26", no: 11, titles: ["Yesterday's pick"] }],
  notice: "AI 生成摘要，以原文为准。",
};

test("Today (magazine): ready, empty, preparing, first visit, signed out and failed are all English", async () => {
  const cases: Array<[string, StubHandler]> = [
    ["ready", () => ({ body: ISSUE })],
    ["zero", () => ({ body: { ...ISSUE, issue: { ...ISSUE.issue, items: [], no: null } } })],
    ["preparing", () => ({ body: { ...ISSUE, issue: null } })],
    ["first", () => ({ body: { projects: [], issue: null, opened: [], archive: [] } })],
    ["signed out", () => ({ status: 401, body: { code: "unauthorized", detail: "请先登录。" } })],
    ["failed", () => ({ status: 503, body: { code: "temporarily_unavailable", detail: "服务暂时不可用" } })],
  ];
  for (const [label, handler] of cases) await expectEnglish(`today ${label}`, createElement(MagazineToday, { fetchImpl: stubFetch(handler).fetch }));
});

test("Archive: a list, an empty archive, signed out and failed are English", async () => {
  const cases: Array<[string, StubHandler]> = [
    ["list", () => ({ body: { issueCount: 2, archive: [{ date: "2026-11-04", no: 10, titles: ["One", "Two"] }, { date: "2026-11-03", no: null, titles: [] }] } })],
    ["empty", () => ({ body: { issueCount: 0, archive: [] } })],
    ["signed out", () => ({ status: 401, body: {} })],
    ["failed", () => ({ status: 500, body: {} })],
  ];
  for (const [label, handler] of cases) await expectEnglish(`archive ${label}`, createElement(ArchivePage, { fetchImpl: stubFetch(handler).fetch }));
});

test("Project today: the API's Chinese empty state and notice give way to English", async () => {
  const base = {
    project: { id: "project:x:y:1", slug: "pabc", target: "AI models", purpose: "Follow releases" },
    window: { since: "2026-10-20T04:00:00.000Z", until: "2026-10-21T04:00:00.000Z" },
    checkpoint: { readThrough: null }, sources: { linked: 1, active: 1 }, cardCount: 3, quietDay: true,
    notice: "全部内容仅为发布方声明、未独立核验；中文标题和摘要由模型生成，是分析，不是证据，以原文为准。",
  };
  const empty = { ...base, result: "no-important-change", emptyState: { title: "无重要变化", detail: "自上次阅读以来……" }, items: [], awaitingAnalysis: 3 };
  const items = {
    ...base, result: "items", emptyState: null, awaitingAnalysis: 0,
    items: [{ id: "i1", title: "Lab ships a model", summary: "What changed", url: "https://example.org/a", source: "Example", publishedAt: "2026-10-21T01:00:00.000Z", listedAt: "2026-10-21T01:00:00.000Z", selected: true, analysis: true }],
  };
  const cases: Array<[string, StubHandler]> = [
    ["no change", () => ({ body: empty })],
    ["items", () => ({ body: items })],
    ["not found", () => ({ status: 404, body: {} })],
    ["signed out", () => ({ status: 401, body: {} })],
    ["failed", () => ({ status: 500, body: {} })],
  ];
  for (const [label, handler] of cases) await expectEnglish(`project today ${label}`, createElement(TodayPage, { projectId: "pabc", fetchImpl: stubFetch(handler).fetch }));
});

function chatHandler(o: { thread?: number; status?: unknown; messages?: unknown[]; post?: { status: number; body: unknown } } = {}): StubHandler {
  return (url, init) => {
    if (url.startsWith("/api/me/chat") && (!init?.method || init.method === "GET")) return o.thread === 401 ? { status: 401, body: {} } : { body: { messages: o.messages ?? [] } };
    if (url === "/api/me/model-status") return { body: o.status ?? { chat: "instance", reason: null, byokAvailable: true } };
    if (url === "/api/projects") return { body: { projects: [{ id: "p1", target: "AI models", purpose: "Follow releases", status: "active", currentRevision: 1 }] } };
    if (url === "/api/me/chat" && init?.method === "POST") return o.post ?? { body: { reply: "Noted.", status: "done", card: null, turnId: 1 } };
    return { status: 404, body: {} };
  };
}

test("Chat: signed out, no model, an intake question with the server's 「其他」 chip, and a refused send are English", async () => {
  await expectEnglish("chat signed out", createElement(ChatPage, { fetchImpl: stubFetch(chatHandler({ thread: 401 })).fetch }));
  await expectEnglish("chat no model", createElement(ChatPage, { fetchImpl: stubFetch(chatHandler({ status: { chat: "none", reason: "not-configured", byokAvailable: true } })).fetch }));
  await expectEnglish("chat model off", createElement(ChatPage, { fetchImpl: stubFetch(chatHandler({ status: { chat: "none", reason: "model-calls-off", byokAvailable: false } })).fetch }));
  const question = [
    { role: "user", text: "Track humanoid robots", createdAt: 1, clientId: "c1" },
    { role: "assistant", text: "Which part matters most?", createdAt: 2, kind: "question", chips: ["Mass production", "Funding", "其他"], step: 1 },
  ];
  await expectEnglish("chat intake chips", createElement(ChatPage, { fetchImpl: stubFetch(chatHandler({ messages: question })).fetch }), async (root) => {
    assert.ok(buttonByText(root, "Other"), "the server's 其他 chip reads Other");
  });
  await expectEnglish(
    "chat refused send",
    createElement(ChatPage, { fetchImpl: stubFetch(chatHandler({ post: { status: 429, body: { code: "rate_limited", detail: "尝试太频繁了，请一分钟后再试。", retryAfter: 60 } } })).fetch }),
    async (root) => {
      const input = root.querySelector("input") as HTMLInputElement;
      const { type } = await import("./harness.ts");
      await type(input, "hello");
      await click(buttonByText(root, "Send"));
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    },
  );
});

test("Settings, project overview and the creation wizard are English", async () => {
  const settings: StubHandler = (url) => {
    if (url === "/api/auth/me") return { body: { user: { email: "a@example.com", locale: "en" } } };
    if (url === "/api/me/keys") return { body: { keys: [{ provider: "openai", last4: "abcd", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }], encryptionConfigured: true } };
    if (url === "/api/me/model-status") return { body: { chat: "user-key", reason: null, byokAvailable: true, userKey: { stored: true, usable: true, problem: null, last4: "abcd" } } };
    if (url === "/api/projects") return { body: { projects: [{ id: "p1", slug: "models", target: "AI models", purpose: "Follow releases" }] } };
    if (url === "/api/me/feed") return { body: { enabled: false } };
    return { status: 404, body: {} };
  };
  await expectEnglish("settings", createElement(SettingsPage, { fetchImpl: stubFetch(settings).fetch }));
  await expectEnglish("settings signed out", createElement(SettingsPage, { fetchImpl: stubFetch(() => ({ status: 401, body: {} })).fetch }));

  const projects: StubHandler = (url) => (url === "/api/projects" ? { body: { projects: [{ id: "p1", target: "AI models", purpose: "Follow releases", status: "active", currentRevision: 1 }] } } : { body: {} });
  await expectEnglish("projects", createElement(ProjectsOverview, { fetchImpl: stubFetch(projects).fetch }));
  await expectEnglish("projects empty", createElement(ProjectsOverview, { fetchImpl: stubFetch(() => ({ body: { projects: [] } })).fetch }));
  await expectEnglish("projects signed out", createElement(ProjectsOverview, { fetchImpl: stubFetch(() => ({ status: 401, body: {} })).fetch }));

  const packs = [{ id: "ai-models", label: "AI models", sources: [{ id: "rss:a", name: "OpenAI News", publisher: "OpenAI", regions: ["us"] }, { id: "rss:b", name: "Mistral", publisher: "Mistral", regions: ["eu"] }] }];
  const wizard: StubHandler = (url, init) => {
    if (url === "/api/packs") return { body: { packs } };
    if (url === "/api/pack-prefs" && init?.method === "PUT") return { body: { packId: "ai-models", picks: [] } };
    if (url === "/api/pack-prefs") return { body: { packId: null, picks: [] } };
    if (url === "/api/projects" && init?.method === "POST") return { status: 400, body: { code: "goal_or_purpose_required", detail: "对象和方向都要有。" } };
    return { status: 404, body: {} };
  };
  await expectEnglish("wizard", createElement(GuidedCreation, { fetchImpl: stubFetch(wizard).fetch }), async (root) => {
    await click(buttonByText(root, "AI models (2 sources)"));
    assert.deepEqual(chineseIn(root), [], "sources step");
    await click(buttonByText(root, "That's all, next"));
    assert.deepEqual(chineseIn(root), [], "naming step");
  });
});

test("API problems: Chinese pages keep the API's detail; English pages say it in English", () => {
  const p = { code: "invalid_credentials", detail: "邮箱或密码不对。", status: 401 };
  assert.equal(problemMessage("zh-CN", p, "x"), "邮箱或密码不对。");
  assert.equal(problemMessage("en", p, "x"), "Wrong email or password.");
  assert.equal(problemMessage("en", { code: "rate_limited", detail: "尝试太频繁了，请稍后再试。", status: 429, retryAfter: 900 }, "x"), "Too many attempts. Try again in 15 minutes.");
  assert.equal(problemMessage("en", { code: "made_up", detail: "某个新错误" }, "Could not sign in."), "Could not sign in.", "an unknown code falls back to the page's own message");
  assert.equal(problemMessage("en", { code: "x", detail: "Already English" }, "f"), "Already English");
  assert.equal(problemMessage("en", null, "f"), "f");
});
