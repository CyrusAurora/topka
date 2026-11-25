// The online demo (apps/web/demo, GitHub Pages): its in-browser API answers the reader pages from the
// exported JSON, runs the demo model's Chat to a confirmed project in both languages, keeps everything
// in the browser, and answers whatever needs a server with a "demo" problem in the page's language.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoApi, installDemoFetch, type DemoPrefs } from "../demo/demo-api.ts";
import { chatTurn, decideCard, emptyChat } from "../demo/demo-chat.ts";
import { DEMO_STRINGS } from "../demo/demo-strings.ts";
import { appPath, withBase } from "../demo/links.ts";
import { contentLangAttr } from "../app/features/magazine/view.ts";
import { CJK } from "./cjk-scan.ts";

const ISSUE = {
  date: "2026-11-17", no: 14, fixedAt: "2026-11-17T00:00:00.000Z", hero: false, ready: true,
  items: [1, 2, 3].map((n) => ({
    id: `2026-11-17-${n}`, position: n, title_a: `标题${n}`, title_b: "", core_a: `一句话${n}`, core_b: "", summary: `摘要${n}`, tag: "", source: "arXiv",
    url: `https://arxiv.org/abs/${n}`, score: null, project: { id: "demo-1", slug: "demo-1", target: "具身智能" }, publishedAt: null, listedAt: "2026-11-16T00:00:00.000Z",
    hasCopy: true, overBudget: false, ledger: "current", withdrawal: null,
  })),
};
const DATA: Record<string, unknown> = {
  "meta.json": { schemaVersion: 1, updatedAt: "2026-11-17T09:00:00.000Z", latestIssueDate: "2026-11-17", issueCount: 2, issueTimeZone: "Asia/Shanghai", contentLang: "zh-CN" },
  "today.json": { schemaVersion: 3, kind: "user-issue", user: { id: "demo" }, projects: [{ id: "demo-1", slug: "demo-1", target: "具身智能" }], generatedAt: "2026-11-17T09:00:00.000Z", nextAt: null, issueCount: 2, issue: ISSUE, opened: [], archive: [], notice: "", contentLang: "zh-CN" },
  "issues.json": { archive: [{ date: "2026-11-16", no: 13, titles: ["旧标题"] }], issueCount: 2, contentLang: "zh-CN" },
  "issues/2026-11-16.json": { issue: { ...ISSUE, date: "2026-11-16", no: 13 }, contentLang: "zh-CN" },
};
const PACKS = [{ id: "embodied-ai", label: "具身智能与机器人", labelEn: "Embodied AI & robotics", sources: [{ id: "rss-humanoid", name: "Humanoid Robotics Weekly", publisher: null, regions: ["global"] }] }];

function demo(locale: DemoPrefs["locale"] = "en") {
  const store = new Map<string, string>();
  let prefs: DemoPrefs = { locale, timeZone: "Asia/Taipei" };
  let t = Date.parse("2026-11-17T10:00:00Z");
  const api = createDemoApi({
    data: async (p) => (p in DATA ? structuredClone(DATA[p]) : null),
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) },
    prefs: () => prefs, setPrefs: (p) => void (prefs = { ...prefs, ...p }), packs: PACKS, now: () => (t += 1000),
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { call, store, prefs: () => prefs };
}

test("today is the latest exported issue with its content language; past issues and a missing day", async () => {
  const d = demo();
  const today = await d.call("/api/me/today");
  assert.equal(today.status, 200);
  assert.equal(today.body.issue.date, "2026-11-17");
  assert.equal(today.body.contentLang, "zh-CN");
  assert.equal(today.body.nextAt, null);
  assert.doesNotMatch(today.body.footNote, CJK, "the English page's foot line is English");
  assert.equal((await demo("zh-CN").call("/api/me/today")).body.footNote, "每天 08:00 更新");
  assert.equal((await d.call("/api/me/issues")).body.archive[0].date, "2026-11-16");
  assert.equal((await d.call("/api/me/issues/2026-11-16")).body.issue.no, 13);
  assert.equal((await d.call("/api/me/issues/2026-01-01")).status, 404);
  // Read marks stay in the browser.
  await d.call("/api/me/issues/read", "POST", { articleId: "2026-11-17-1" });
  assert.deepEqual((await d.call("/api/me/today")).body.opened, ["2026-11-17-1"]);
  // The card copy is marked with its own language on a page in another.
  assert.equal(contentLangAttr("zh-CN", "en"), "zh-CN");
  assert.equal(contentLangAttr("zh-CN", "zh-CN"), undefined);
});

for (const locale of ["en", "zh-CN"] as const) {
  test(`Chat with the demo model (${locale}): questions → card → confirm creates a browser-only project, which Chat can delete`, async () => {
    const d = demo(locale);
    const en = locale === "en";
    const say = en ? ["Help me track humanoid robots", "Technical progress", "Marketing posts", "Yes, go with this"] : ["帮我跟踪人形机器人", "技术进展", "营销稿", "对，就按这个"];
    let card: Record<string, any> | null = null;
    for (const [i, text] of say.entries()) {
      const r = await d.call("/api/me/chat", "POST", { text, clientId: `c${i}` });
      assert.equal(r.body.status, "done", r.body.reply);
      if (en) assert.doesNotMatch(r.body.reply, CJK, r.body.reply);
      if (r.body.card) card = r.body.card;
    }
    assert.ok(card, "a tracking card");
    assert.equal(card!.payload.target, en ? "humanoid robots" : "人形机器人");
    assert.deepEqual(card!.sources.pending.map((s: { id: string }) => s.id), ["rss-humanoid"], "sources are picked from the shipped packs");
    assert.deepEqual((await d.call("/api/me/chat/confirm", "POST", { proposalId: card!.id })).body, { ok: true });
    const projects = (await d.call("/api/projects")).body.projects as Array<{ id: string; target: string }>;
    assert.deepEqual(projects.map((p) => p.target), ["具身智能", en ? "humanoid robots" : "人形机器人"]);
    const mine = projects[1]!;
    // Its page says honestly that nothing is collected here.
    const page = await d.call(`/api/projects/${mine.id}/today`);
    assert.equal(page.body.sources.collectionOn, false);
    if (en) assert.doesNotMatch(JSON.stringify(page.body.emptyState), CJK);
    // Delete it by name, the way the tutorial says.
    const del = await d.call("/api/me/chat", "POST", { text: en ? "Delete the humanoid robots project" : "删除人形机器人这个项目", clientId: "del" });
    assert.equal(del.body.card?.kind, "delete", del.body.reply);
    assert.equal(del.body.card.before.target, en ? "humanoid robots" : "人形机器人");
    assert.ok(del.body.card.warning, "a delete card carries the warning (the page words it)");
    assert.deepEqual((await d.call("/api/me/chat/confirm", "POST", { proposalId: del.body.card.id })).body, { ok: true });
    assert.deepEqual(((await d.call("/api/projects")).body.projects as Array<{ target: string }>).map((p) => p.target), ["具身智能"]);
    // The chat history survives a reload (it is in the browser's storage).
    const history = (await d.call("/api/me/chat")).body.messages as Array<{ role: string }>;
    assert.equal(history.filter((m) => m.role === "user").length, 5);
  });
}

test("the real project cannot be deleted from the demo; a stale card cannot be confirmed", async () => {
  const d = demo("en");
  const r = await d.call("/api/me/chat", "POST", { text: "Delete the 具身智能 project", clientId: "x" });
  assert.equal(r.body.card, null, "only the visitor's own projects can be deleted");
  // decideCard: superseded and cancelled cards.
  let s = emptyChat();
  const ctx = { lang: "en" as const, projects: [{ id: "local-1", slug: "local-1", target: "chips", purpose: "", focus: "", exclusions: "", sourceIds: [], createdAt: "", local: true }], catalog: [], now: 1 };
  s = chatTurn(s, "Delete the chips project", ctx).state;
  const first = Object.keys(s.cards)[0]!;
  s = chatTurn(s, "Delete the chips project", { ...ctx, now: 2 }).state;
  assert.deepEqual(decideCard(s, first, "confirm", ctx.projects, 3).body, { ok: false, state: "superseded" });
  const second = Object.keys(s.cards).find((k) => k !== first)!;
  assert.deepEqual(decideCard(s, second, "cancel", ctx.projects, 3).body, { ok: false, state: "cancelled" });
  assert.deepEqual(decideCard(s, "nope", "confirm", ctx.projects, 3).body, { ok: false, state: "not-found" });
});

test("what needs a server answers a 'demo' problem in the page's language", async () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const d = demo(locale);
    for (const [path, method] of [["/api/auth/login", "POST"], ["/api/me/keys/openrouter", "PUT"], ["/api/feedback", "POST"], ["/api/me/issue-feed", "POST"], ["/api/auth/me", "DELETE"]] as const) {
      const r = await d.call(path, method, {});
      assert.equal(r.status, 403, path);
      assert.equal(r.body.code, "demo");
      if (locale === "en") assert.doesNotMatch(r.body.detail, CJK, `${path}: ${r.body.detail}`);
      else assert.match(r.body.detail, CJK);
    }
  }
  // Language and time zone are settings the demo keeps in the browser.
  const d = demo("en");
  await d.call("/api/auth/me", "PATCH", { locale: "zh-CN", timezone: "Europe/Berlin" });
  assert.deepEqual(d.prefs(), { locale: "zh-CN", timeZone: "Europe/Berlin" });
  assert.equal((await d.call("/api/auth/me")).body.user.email, "reader@example.com");
});

test("installDemoFetch takes /api/ requests only; everything else still goes to the network", async () => {
  const seen: string[] = [];
  const target = { fetch: (async (input: RequestInfo | URL) => { seen.push(String(input)); return new Response("net"); }) as typeof fetch };
  installDemoFetch(async (path) => new Response(`demo ${path}`), target);
  assert.equal(await (await target.fetch("/api/me/today")).text(), "demo /api/me/today");
  assert.equal(await (await target.fetch("/topka/data/meta.json")).text(), "net");
  assert.equal(await (await target.fetch("https://example.org/api/x")).text(), "net");
  assert.deepEqual(seen, ["/topka/data/meta.json", "https://example.org/api/x"]);
});

test("links: root paths move under the Pages base, and only same-site paths are routed in the app", () => {
  assert.equal(withBase("/archive", "/topka/"), "/topka/archive");
  assert.equal(withBase("/topka/archive", "/topka/"), "/topka/archive");
  assert.equal(withBase("/topka", "/topka/"), "/topka");
  assert.equal(withBase("https://arxiv.org/abs/1", "/topka/"), "https://arxiv.org/abs/1");
  assert.equal(withBase("//evil.example/x", "/topka/"), "//evil.example/x");
  assert.equal(withBase("/archive", "/"), "/archive");
  assert.equal(appPath("/topka/issue/2026-11-17", "/topka/"), "/issue/2026-11-17");
  assert.equal(appPath("/topka", "/topka/"), "/");
  assert.equal(appPath("/other/x", "/topka/"), null);
  assert.equal(appPath("https://github.com/x", "/topka/"), null);
});

test("the demo line is one line in either language, and its English has no Chinese", () => {
  for (const v of Object.values(DEMO_STRINGS.en)) assert.doesNotMatch(String(v), CJK, String(v));
  assert.deepEqual([DEMO_STRINGS["zh-CN"].badge, DEMO_STRINGS["zh-CN"].selfHost, DEMO_STRINGS["zh-CN"].source], ["在线体验", "自己部署", "源代码"]);
});
