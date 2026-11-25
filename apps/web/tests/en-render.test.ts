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
import { DiscoverPage } from "../app/features/discover/discover-view.ts";
import { SignalsAwaitingSection } from "../app/features/discover/signals.ts";
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
    ["offline", () => { throw new TypeError("Failed to fetch"); }],
    ["snapshot failed", () => ({ body: { ...empty, result: "snapshot-failed", snapshot: { id: null, ackSeq: 0, acknowledgementAllowed: false } } })],
    ["abstained", () => ({ body: { ...empty, result: "abstained-impact", unassessed: 2 } })],
    [
      "partial coverage, corrected",
      (url) => ({
        body: url.endsWith("/today") ? {
          ...items, result: "partial-coverage", items: items.items.map((i) => ({ ...i, ledger: "corrected" })),
          checkpoint: { readThrough: "2026-10-20T04:00:00.000Z", ackSeq: 1, receiptId: "receipt-00016c83" },
          coverage: { satisfied: false, sources: [{ sourceId: "s1", name: "Example", required: true, status: "never-checked", checkedAtUtc: null }] },
        } : {},
      }),
    ],
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

test("Discovery: the /discover page and the project's unconfirmed-signals block are English in every state", async () => {
  const sig = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `s${n}`, kind: "directory", channelName: "Directory A", url: `https://example.org/${n}`, title: `Lead ${n}`, note: "Seen on a forum",
    discoveredAt: "2026-11-17T01:00:00.000Z", projectId: null, invalidUrl: false, duplicates: 1, ...extra,
  });
  const pending = { items: [sig(1), sig(2, { kind: "user-lead", channelName: "reader", invalidUrl: true, url: "ftp://x" }), sig(3, { kind: "pack", channelName: "Pack B" })], total: 30, hidden: 10, cap: 20 };
  const promoted = [{ ...sig(9), promotedAt: "2026-11-17T02:00:00.000Z", observation: { id: "obs1", title: "Original", url: "https://example.org/9", sourceName: "Src" } }];
  const view = {
    catalog: { feedCount: 1, enabled: true, lastRunAt: "2026-11-17T03:00:00.000Z", total: 2, feeds: [
      { id: "f1", name: "Feed one", feedUrl: null, active: true, lastRead: { at: "2026-11-17T03:00:00.000Z", ok: false, found: 0, error: "HTTP 500" } },
      { id: "f2", name: "Feed two", feedUrl: null, active: false, lastRead: null }] },
    pending, promoted, projects: [{ id: "p1", slug: "p1", target: "Robots" }],
  };
  const cases: Array<[string, StubHandler]> = [
    ["ready", () => ({ body: view })],
    ["empty", () => ({ body: { ...view, catalog: { ...view.catalog, enabled: false, lastRunAt: null }, pending: { items: [], total: 0, hidden: 0, cap: 20 }, promoted: [], projects: [] } })],
    ["signed out", () => ({ status: 401, body: { code: "unauthorized", detail: "请先登录。" } })],
    ["failed", () => ({ status: 500, body: { detail: "服务暂时不可用" } })],
  ];
  for (const [label, handler] of cases) await expectEnglish(`discover ${label}`, createElement(DiscoverPage, { fetchImpl: stubFetch(handler).fetch }));
  const sections: Array<[string, StubHandler]> = [
    ["list", () => ({ body: { pending, promoted } })],
    ["empty", () => ({ body: { pending: { items: [], total: 0, hidden: 0, cap: 20 }, promoted: [] } })],
    ["failed", () => ({ status: 500, body: { detail: "服务暂时不可用" } })],
  ];
  for (const [label, handler] of sections) await expectEnglish(`signals ${label}`, createElement(SignalsAwaitingSection, { projectId: "p1", fetchImpl: stubFetch(handler).fetch }));
  // A refused lead: the API's Chinese detail is never shown, the page says it in English.
  await expectEnglish("signals refused lead", createElement(SignalsAwaitingSection, {
    projectId: "p1",
    fetchImpl: stubFetch((_url, init) => (init?.method === "POST" ? { status: 400, body: { code: "too_many", detail: "这个项目的待证线索已经太多" } } : { body: { pending, promoted } })).fetch,
  }), async (root) => {
    const form = root.querySelector("[data-lead-form]") as HTMLElement;
    const input = form.querySelector("input") as HTMLInputElement;
    const { type } = await import("./harness.ts");
    await type(input, "https://example.org/x");
    await click(buttonByText(form, messages("en").discover.leadSubmit));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  });
});

// Card copy follows the reader's language when it was written, so an English reader can still have
// older issues (and their own project names) in Chinese. The live API does not name the copy's
// language, so the page marks Chinese text by what it is: every CJK run under an English page sits
// inside an element that says lang="zh-CN" (fonts and screen readers pick the right voice and glyphs).
function unmarkedChinese(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? "";
    if (!CJK.test(text)) continue;
    if (n.parentElement?.closest("[lang]")?.getAttribute("lang") !== "zh-CN") out.push(text.trim());
  }
  return out;
}

test("Chinese copy and project names on an English page are marked lang=zh-CN without a contentLang", async () => {
  const zhItem = (n: number) => ({ ...item(n), title_a: `机器人公司发布新模型 ${n}`, core_a: "更快更便宜", summary: `摘要 ${n}`, source: "量子位", project: { id: "p1", slug: "robots", target: "人形机器人" } });
  const zhIssue = { ...ISSUE, projects: [{ id: "p1", slug: "robots", target: "人形机器人" }], issue: { ...ISSUE.issue, items: [zhItem(1), zhItem(2), zhItem(3)] }, archive: [] };
  const cases: Array<[string, ReactElement]> = [
    ["today", createElement(MagazineToday, { fetchImpl: stubFetch(() => ({ body: zhIssue })).fetch })],
    ["archive", createElement(ArchivePage, { fetchImpl: stubFetch(() => ({ body: { issueCount: 1, archive: [{ date: "2026-11-04", no: 10, titles: ["机器人公司发布新模型", "更快更便宜"] }] } })).fetch })],
    ["projects", createElement(ProjectsOverview, { fetchImpl: stubFetch(() => ({ body: { projects: [{ id: "p1", slug: "robots", target: "人形机器人", purpose: "跟踪人形机器人的量产进展", status: "active", currentRevision: 1 }] } })).fetch })],
  ];
  for (const [label, node] of cases) {
    const page = await renderEn(node);
    try {
      assert.ok(CJK.test(page.container.textContent ?? ""), `${label}: the Chinese copy is shown`);
      assert.deepEqual(unmarkedChinese(page.container), [], `${label}: Chinese text without lang=zh-CN`);
    } finally {
      await page.teardown();
    }
  }
});
