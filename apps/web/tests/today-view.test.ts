// The today reading view: the explicit 无重要变化 result, the item list with original links and
// sources, "看完了" sending back the window the reader saw, and honest signed-out/not-found states.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { TodayPage, ACK_LABEL, ACK_DONE, type TodayView } from "../app/features/today/today-view.ts";
import { buttonByText, click, includes, mount, stubFetch } from "./harness.ts";

const base: TodayView = {
  project: { id: "project:x:y:12345678", slug: "pabcdefabcdef", target: "具身智能", purpose: "跟踪进展" },
  window: { since: "2026-10-20T04:00:00.000Z", until: "2026-10-21T04:00:00.000Z" },
  checkpoint: { readThrough: null },
  sources: { linked: 15, active: 15 },
  result: "no-important-change",
  emptyState: { title: "无重要变化", detail: "自上次阅读以来，关注的来源里没有达到重要更新条件的新内容。" },
  items: [],
  cardCount: 3,
  quietDay: true,
  awaitingAnalysis: 0,
  notice: "全部内容仅为发布方声明、未独立核验。",
};
const API = "/api/projects/pabcdefabcdef/today";

async function render(handler: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(handler);
  const page = await mount();
  await page.render(createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch }));
  await page.render(createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch }));
  return { stub, page };
}

test("nothing qualifying shows 无重要变化 and how many items still wait for analysis", async () => {
  const { page } = await render((url) => (url === API ? { body: { ...base, awaitingAnalysis: 121 } } : { body: {} }));
  assert.ok(includes(page.container, "无重要变化"), page.container.textContent);
  assert.ok(includes(page.container, "121 条新采集的内容还没分析"));
  assert.ok(includes(page.container, "具身智能"));
  await page.teardown();
});

test("items show the Chinese title, analysis-labelled summary, source and original link; 看完了 sends the window back", async () => {
  const view: TodayView = {
    ...base,
    result: "updates-available",
    emptyState: null,
    quietDay: false,
    items: [
      { id: "a1", title: "中文标题一", originalTitle: "Title one", summary: "摘要一", url: "https://example.org/1", source: { id: "s1", name: "arXiv cs.RO" }, publishedAt: "2026-10-21T01:00:00.000Z", listedAt: "2026-10-21T02:00:00.000Z", selected: true },
      { id: "a2", title: "Title two", originalTitle: null, summary: null, url: "https://example.org/2", source: { id: "s2", name: "MuJoCo Releases" }, publishedAt: null, listedAt: "2026-10-21T03:00:00.000Z", selected: false },
    ],
  };
  const { stub, page } = await render((url, init) => {
    if (url === API) return { body: view };
    if (url === `${API}/ack` && init?.method === "POST") return { body: { checkpoint: { readThrough: view.window.until, advanced: true } } };
    return { status: 404, body: {} };
  });
  for (const text of ["中文标题一", "Title one", "摘要一", "arXiv cs.RO", "Title two", "MuJoCo Releases"]) assert.ok(includes(page.container, text), text);
  assert.ok(!includes(page.container, "无重要变化"));
  const links = [...page.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  const hrefs = new Set(links);
  for (const want of ["https://example.org/1", "https://example.org/2"]) assert.ok(hrefs.has(want), want);
  await click(buttonByText(page.container, ACK_LABEL));
  await page.render(createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch }));
  const sent = stub.calls.find((c) => c.url === `${API}/ack`);
  assert.ok(sent, "the acknowledgement was sent");
  assert.deepEqual(JSON.parse(String(sent!.init!.body)), { through: view.window.until });
  assert.ok(includes(page.container, ACK_DONE), page.container.textContent);
  await page.teardown();
});

test("a signed-out visitor is asked to sign in; a signed-in non-owner sees not-found", async () => {
  const out = await render((url) => (url === API ? { status: 404, body: {} } : { status: 401, body: {} }));
  assert.ok(includes(out.page.container, "请先登录"), out.page.container.textContent);
  await out.page.teardown();
  const other = await render((url) => (url === API ? { status: 404, body: {} } : { body: { user: {} } }));
  assert.ok(includes(other.page.container, "没有这个项目"), other.page.container.textContent);
  await other.page.teardown();
});
