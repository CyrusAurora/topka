// The today reading view: the explicit 无重要变化 result, the item list with original links and
// sources, "看完了" naming the snapshot it confirms (snapshotId, ackSeq, the cards shown, a commandId
// kept for retries), every blocking row of the checkpoint decision table (offline-or-auth,
// snapshot-failed, partial-coverage, abstained-impact) disabling it with its reason, refusals said in
// words, corrected observations with their earlier versions, the Required toggle, and honest
// signed-out/not-found states.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { TodayPage, ACK_LABEL, ACK_DONE, type TodayView } from "../app/features/today/today-view.ts";
import { buttonByText, checkboxes, click, includes, mount, stubFetch } from "./harness.ts";

const base: TodayView = {
  project: { id: "project:x:y:12345678", slug: "pabcdefabcdef", target: "具身智能", purpose: "跟踪进展" },
  window: { since: "2026-10-20T04:00:00.000Z", until: "2026-10-21T04:00:00.000Z" },
  checkpoint: { readThrough: null, ackSeq: 0, receiptId: null },
  snapshot: { id: "brief-snapshot-v1:0123456789abcdef0123456789abcdef", ackSeq: 0, acknowledgementAllowed: true },
  sources: { linked: 15, active: 15 },
  coverage: { satisfied: true, sources: [] },
  unassessed: 0,
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
    if (url === `${API}/ack` && init?.method === "POST") return { body: { checkpoint: { readThrough: view.window.until, advanced: true, receiptId: "receipt-b43f8da7" } } };
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
  const sentBody = JSON.parse(String(sent!.init!.body));
  assert.equal(sentBody.snapshotId, base.snapshot!.id);
  assert.equal(sentBody.ackSeq, 0);
  assert.deepEqual(sentBody.shownIds, ["a1", "a2"]);
  assert.ok(typeof sentBody.commandId === "string" && sentBody.commandId.length >= 8, "a commandId is sent");
  assert.equal(sentBody.through, undefined, "the old {through} body is gone");
  assert.ok(includes(page.container, ACK_DONE), page.container.textContent);
  assert.ok(includes(page.container, "receipt-b43f8da7"), "the receipt is shown");
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

const ackButton = (page: { container: HTMLElement }) => buttonByText(page.container, ACK_LABEL);

test("every blocking result of the decision table disables 看完了 and says why", async () => {
  const cases: Array<[string, Partial<TodayView>, string]> = [
    ["snapshot-failed", { result: "snapshot-failed", snapshot: { id: null, ackSeq: 0, acknowledgementAllowed: false } }, "没能保存下来"],
    [
      "partial-coverage",
      {
        result: "partial-coverage",
        snapshot: { ...base.snapshot!, acknowledgementAllowed: false },
        coverage: { satisfied: false, sources: [{ sourceId: "s1", name: "arXiv cs.RO", required: true, status: "stale", checkedAtUtc: "2026-10-20T01:00:00.000Z" }] },
      },
      "覆盖不完整：必需的来源最近没查到（arXiv cs.RO）",
    ],
    ["abstained-impact", { result: "abstained-impact", unassessed: 4, awaitingAnalysis: 4, snapshot: { ...base.snapshot!, acknowledgementAllowed: false } }, "未知不会变成否定"],
  ];
  for (const [label, patch, text] of cases) {
    const { page, stub } = await render((url) => (url === API ? { body: { ...base, ...patch } } : { status: 404, body: {} }));
    assert.ok(includes(page.container, text), `${label}: ${page.container.textContent}`);
    assert.ok(page.container.querySelector(`[data-result="${label}"]`), `${label} banner`);
    assert.equal(ackButton(page).disabled, true, `${label} cannot be confirmed`);
    await click(ackButton(page));
    assert.equal(stub.count(`${API}/ack`, "POST"), 0, `${label} sends nothing`);
    await page.teardown();
  }
  // The two confirmable rows enable it.
  for (const result of ["no-important-change", "updates-available"] as const) {
    const { page } = await render((url) => (url === API ? { body: { ...base, result } } : { status: 404, body: {} }));
    assert.equal(ackButton(page).disabled, false, result);
    await page.teardown();
  }
});

test("a refusal is said in words; a refresh while offline keeps the brief readable but not confirmable", async () => {
  let online = true;
  const { page, stub } = await render((url, init) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (url === API) return { body: { ...base, checkpoint: { readThrough: "2026-10-20T04:00:00.000Z", ackSeq: 1, receiptId: "receipt-00016c83" } } };
    if (url === `${API}/ack` && init?.method === "POST") return { status: 409, body: { code: "ack_seq_mismatch" } };
    return { status: 404, body: {} };
  });
  assert.ok(includes(page.container, "上次确认："), "last confirmed time is shown");
  await click(ackButton(page));
  await page.render(createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch }));
  assert.ok(includes(page.container, "在别的设备上已经确认过了"), page.container.textContent);
  online = false;
  await click(buttonByText(page.container, "刷新"));
  await page.render(createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch }));
  assert.ok(includes(page.container, "当前没网，已保存的历史证据还能看，联网后自动恢复。"), page.container.textContent);
  assert.ok(includes(page.container, "无重要变化"), "the last brief stays readable");
  assert.ok(page.container.querySelector('[data-result="offline-or-auth"]'));
  assert.equal(ackButton(page).disabled, true);
  await page.teardown();
});

test("a retried confirmation of the same snapshot reuses its commandId", async () => {
  let answer: { status: number; body: unknown } = { status: 500, body: {} };
  const { page, stub } = await render((url, init) => {
    if (url === API) return { body: base };
    if (url === `${API}/ack` && init?.method === "POST") return answer;
    return { status: 404, body: {} };
  });
  await click(ackButton(page));
  await page.render(createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch }));
  answer = { status: 200, body: { checkpoint: { receiptId: "receipt-00016c83" } } };
  await click(ackButton(page));
  await page.render(createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch }));
  const ids = stub.calls.filter((c) => c.url === `${API}/ack`).map((c) => JSON.parse(String(c.init!.body)).commandId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.ok(includes(page.container, "receipt-00016c83"));
  await page.teardown();
});

test("a corrected observation carries a chip and opens its earlier versions; Required is toggled with PUT", async () => {
  const view: TodayView = {
    ...base, result: "updates-available", emptyState: null,
    coverage: { satisfied: true, sources: [{ sourceId: "s1", name: "arXiv cs.RO", required: false, status: "checked", checkedAtUtc: "2026-10-21T01:00:00.000Z" }] },
    items: [{ id: "a1", title: "新标题", originalTitle: null, summary: null, url: "https://example.org/1", source: { id: "s1", name: "arXiv cs.RO" }, publishedAt: null, listedAt: "2026-10-21T02:00:00.000Z", selected: false, ledger: "corrected" }],
  };
  const { page, stub } = await render((url, init) => {
    if (url === API) return { body: view };
    if (url === "/api/me/items/a1/history") return { body: { history: { revisions: [{ revision: 1, title: "旧标题", recordedAt: "2026-10-20T01:00:00.000Z" }, { revision: 2, title: "新标题", recordedAt: "2026-10-21T01:00:00.000Z" }], conflicts: [{ title: "冲突标题", excerpt: null, reportedAt: "2026-10-21T01:30:00.000Z" }] } } };
    if (url === "/api/projects/pabcdefabcdef/sources/s1" && init?.method === "PUT") return { body: { ok: true } };
    return { status: 404, body: {} };
  });
  assert.ok(page.container.querySelector('[data-ledger="corrected"]'));
  assert.ok(includes(page.container, "来源已更正"));
  await click(buttonByText(page.container, "看更正前的版本"));
  await page.render(createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch }));
  for (const text of ["旧标题", "第 1 版", "被拒收的冲突报告", "冲突标题"]) assert.ok(includes(page.container, text), text);
  assert.ok(includes(page.container, "来源覆盖") && includes(page.container, "已查到"));
  await click(checkboxes(page.container)[0]!);
  await page.render(createElement(TodayPage, { projectId: "pabcdefabcdef", fetchImpl: stub.fetch }));
  const put = stub.calls.find((c) => c.url.endsWith("/sources/s1") && c.init?.method === "PUT");
  assert.ok(put, "Required was saved");
  assert.deepEqual(JSON.parse(String(put!.init!.body)), { required: true });
  await page.teardown();
});
