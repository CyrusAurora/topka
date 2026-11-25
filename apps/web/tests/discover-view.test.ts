// Pending-evidence signals on the reader's side (master design 2.2/2.3; handover 2.9, copy locked):
// the project page keeps evidence above and unconfirmed signals below; the lower block shows the
// 待证 chip, title or link, channel provenance and note, the honest empty state, the cap note, an
// invalid link marked "never promoted", the lead form's three outcomes and its refusals, dismissal,
// and promotion lineage lines; the /discover page shows the catalog, the pending list and promotions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { SignalsAwaitingSection } from "../app/features/discover/signals.ts";
import { DiscoverPage } from "../app/features/discover/discover-view.ts";
import { TodayPage } from "../app/features/today/today-view.ts";
import { buttonByText, click, includes, mount, stubFetch, type, type StubHandler } from "./harness.ts";

const API = "/api/projects/p1/signals";
const sig = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `s${n}`, kind: "directory", channelName: "目录 A", url: `https://example.org/${n}`, title: `线索 ${n}`, note: null,
  discoveredAt: "2026-11-17T01:00:00.000Z", projectId: null, invalidUrl: false, duplicates: 0, ...extra,
});
const promo = { ...sig(9, { kind: "user-lead", channelName: "reader" }), promotedAt: "2026-11-17T02:00:00.000Z", observation: { id: "obs123", title: "原文标题", url: "https://example.org/9", sourceName: "来源" } };

async function section(handler: StubHandler) {
  const stub = stubFetch(handler);
  const page = await mount();
  await page.render(createElement(SignalsAwaitingSection, { projectId: "p1", fetchImpl: stub.fetch }));
  await page.render(createElement(SignalsAwaitingSection, { projectId: "p1", fetchImpl: stub.fetch }));
  await new Promise((r) => setTimeout(r, 20));
  return { stub, page };
}

test("the lower block: locked title, intro and honest empty state", async () => {
  const { page } = await section(() => ({ body: { pending: { items: [], total: 0, hidden: 0, cap: 20 }, promoted: [] } }));
  assert.ok(includes(page.container, "待证实的风声"));
  assert.ok(includes(page.container, "这些是从渠道发现的线索，还没有保住可核查的原文，不能算更新。"));
  assert.ok(includes(page.container, "现在没有待证的风声。"));
  assert.ok(page.container.querySelector("[data-lead-form]"));
  await page.teardown();
});

test("a signal shows the 待证 chip, title, provenance, note; an invalid link is marked and not a link; the cap is said", async () => {
  const items = [
    sig(1, { note: "论坛上看到的", duplicates: 2 }),
    sig(2, { kind: "user-lead", channelName: "reader", url: "ftp://x/y", title: null, invalidUrl: true, projectId: "p1" }),
    sig(3, { kind: "pack", channelName: "策展包 B" }),
  ];
  const { page } = await section(() => ({ body: { pending: { items, total: 25, hidden: 22, cap: 20 }, promoted: [promo] } }));
  assert.equal(page.container.querySelectorAll("[data-awaiting-chip]").length, 3);
  assert.ok(includes(page.container, "线索 1") && includes(page.container, "目录：目录 A") && includes(page.container, "论坛上看到的"));
  assert.ok(includes(page.container, "另有 2 条同一链接的线索已折叠"));
  assert.ok(includes(page.container, "策展包：策展包 B"));
  assert.ok(includes(page.container, "你给的线索：你给的线索"));
  const invalid = page.container.querySelector('[data-signal="s2"]')!;
  assert.ok(includes(invalid as HTMLElement, "链接无效，永远不会晋升"));
  assert.equal(invalid.querySelector('a[href="ftp://x/y"]'), null, "an invalid link is not clickable");
  assert.ok(includes(page.container, "只显示最近 20 条，另有 22 条没列出。"));
  assert.ok(includes(page.container, "频道信号已证实：你给的线索（https://example.org/9）→ obs123"));
  await page.teardown();
});

test("the lead form: saved, promoted, invalid and refused, each said; dismissal posts and reloads", async () => {
  let answer: { status?: number; body: unknown } = { status: 201, body: { created: true, promoted: false, signal: { invalidUrl: false } } };
  const { stub, page } = await section((url, init) => {
    if (url === API && init?.method === "POST") return answer;
    if (url.endsWith("/dismiss")) return { body: { signal: { status: "dismissed" } } };
    return { body: { pending: { items: [sig(1)], total: 1, hidden: 0, cap: 20 }, promoted: [] } };
  });
  const form = page.container.querySelector("[data-lead-form]")!;
  const submit = buttonByText(form as HTMLElement, "记下线索");
  assert.equal(submit.disabled, true, "nothing to send without a link");
  const inputs = form.querySelectorAll<HTMLInputElement>("input");
  const send = async (url: string) => {
    await type(inputs[0]!, url);
    await type(inputs[1]!, "备注");
    await click(buttonByText(form as HTMLElement, "记下线索"));
    await new Promise((r) => setTimeout(r, 10));
  };
  await send("https://example.org/new");
  assert.ok(includes(page.container, "记下了，现在算待证。"));
  const posted = stub.calls.find((c) => c.url === API && c.init?.method === "POST")!;
  assert.deepEqual(JSON.parse(String(posted.init!.body)), { url: "https://example.org/new", note: "备注" });
  answer = { status: 201, body: { created: true, promoted: true, signal: { invalidUrl: false } } };
  await send("https://example.org/known");
  assert.ok(includes(page.container, "已有同一链接的原文，这条线索直接算证实了。"));
  answer = { status: 201, body: { created: true, promoted: false, signal: { invalidUrl: true } } };
  await send("not a link");
  assert.ok(includes(page.container, "记下了，但这个链接无效，会一直留在待证区，不会晋升。"));
  answer = { status: 400, body: { code: "too_many" } };
  await send("https://example.org/more");
  assert.ok(includes(page.container, "这个项目的待证线索太多了，先处理一些再加。"));
  await click(buttonByText(page.container, "不再显示"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stub.count(`${API}/s1/dismiss`, "POST"), 1);
  await page.teardown();
});

test("the lower block stays out of the way when the project is not the reader's, and says so when it fails", async () => {
  const hidden = await section(() => ({ status: 404, body: {} }));
  assert.equal(hidden.page.container.querySelector("[data-signals-section]"), null);
  await hidden.page.teardown();
  const failed = await section(() => ({ status: 500, body: {} }));
  assert.ok(includes(failed.page.container, "待证线索暂时读不到。"));
  await failed.page.teardown();
  const offline = await section(() => { throw new TypeError("Failed to fetch"); });
  assert.ok(includes(offline.page.container, "待证线索暂时读不到。"));
  await offline.page.teardown();
});

test("the project page: evidence above, unconfirmed signals below, and a card names the signal it confirmed", async () => {
  const today = {
    project: { id: "p1", slug: "p1", target: "具身智能", purpose: "跟踪" }, window: { since: "2026-11-16T00:00:00.000Z", until: "2026-11-17T00:00:00.000Z" },
    checkpoint: { readThrough: null, ackSeq: 0 }, snapshot: { id: "brief-snapshot-v1:x", ackSeq: 0, acknowledgementAllowed: true },
    sources: { linked: 1, active: 1 }, coverage: { satisfied: true, sources: [] }, unassessed: 0, result: "updates-available", emptyState: null,
    items: [{ id: "a1", title: "证据一", originalTitle: null, summary: null, url: "https://example.org/a1", source: { id: "s", name: "来源" }, publishedAt: null, listedAt: "2026-11-16T12:00:00.000Z", selected: false,
      confirmedSignals: [{ channelName: "目录 A", url: "https://example.org/a1?utm_source=x", kind: "directory" }] }],
    cardCount: 3, quietDay: false, awaitingAnalysis: 0,
  };
  const stub = stubFetch((url) => (url === "/api/projects/p1/today" ? { body: today } : url === API ? { body: { pending: { items: [sig(1)], total: 1, hidden: 0, cap: 20 }, promoted: [] } } : { body: {} }));
  const page = await mount();
  await page.render(createElement(TodayPage, { projectId: "p1", fetchImpl: stub.fetch }));
  await page.render(createElement(TodayPage, { projectId: "p1", fetchImpl: stub.fetch }));
  await new Promise((r) => setTimeout(r, 30));
  const text = page.container.textContent ?? "";
  assert.ok(text.indexOf("证据一") < text.indexOf("待证实的风声"), "evidence first, signals after");
  assert.ok(includes(page.container, "频道信号已证实：目录 A"));
  assert.equal(page.container.querySelector("ol")?.querySelector("[data-awaiting-chip]"), null, "no signal among the evidence cards");
  await page.teardown();
});

test("/discover: catalog with the active feeds first, the pending list, promotions and project links; signed out and failed", async () => {
  const view = {
    catalog: { feedCount: 1, enabled: true, lastRunAt: "2026-11-17T03:00:00.000Z", total: 2, feeds: [
      { id: "f2", name: "未读的源", feedUrl: null, active: false, lastRead: null },
      { id: "f1", name: "读取的源", feedUrl: "https://example.org/feed", active: true, lastRead: { at: "2026-11-17T03:00:00.000Z", ok: true, found: 7, error: null } },
    ] },
    pending: { items: [sig(1)], total: 1, hidden: 0, cap: 20 },
    promoted: [promo],
    projects: [{ id: "p1", slug: "p1", target: "具身智能" }],
  };
  const stub = stubFetch(() => ({ body: view }));
  const page = await mount();
  await page.render(createElement(DiscoverPage, { fetchImpl: stub.fetch }));
  await new Promise((r) => setTimeout(r, 20));
  const feeds = [...page.container.querySelectorAll("[data-feed]")].map((li) => li.getAttribute("data-feed"));
  assert.deepEqual(feeds, ["f1", "f2"]);
  assert.ok(includes(page.container, "目录里共 2 个订阅源，当前读取前 1 个。"));
  assert.ok(includes(page.container, "读取中 · 上次 7 条"));
  assert.ok(includes(page.container, "显示 1 / 1 条（最多 20 条，最新发现的在前）"));
  assert.ok(includes(page.container, "频道信号已证实：你给的线索（https://example.org/9）→ obs123"));
  assert.ok(page.container.querySelector('a[href="/projects/p1#signals"]'));
  await page.teardown();
  for (const [label, handler, expected] of [
    ["signed out", () => ({ status: 401, body: {} }), "请先登录。"],
    ["failed", () => ({ status: 500, body: {} }), "待证线索暂时读不到。"],
    ["bad shape", () => ({ body: { pending: null } }), "待证线索暂时读不到。"],
  ] as Array<[string, StubHandler, string]>) {
    const p = await mount();
    await p.render(createElement(DiscoverPage, { fetchImpl: stubFetch(handler).fetch }));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(includes(p.container, expected), label);
    await p.teardown();
  }
});
