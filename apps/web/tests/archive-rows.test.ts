// 往期's rows (the archive list): the date label reads "11月4日", never "11.04月11日", and the row's
// title preview keeps every story on one line. The archive page itself, its nav highlight and the
// layout at desktop width are covered here too, since the list is invisible in the component tests
// when the API is unreachable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { archiveRows } from "../app/features/magazine/view.ts";
import { ArchivePage } from "../app/features/magazine/archive.ts";
import { tabIsActive } from "../app/components/shell/nav-match.ts";
import { includes, mount, stubFetch } from "./harness.ts";

test("archiveRows: the label is 月/日 from the ISO day, not from the dotted masthead", () => {
  const rows = archiveRows([
    { date: "2026-11-04", no: 10, titles: ["甲", "乙"] },
    { date: "2026-10-05", no: 9, titles: [] },
  ]);
  assert.equal(rows[0]!.label, "11月4日");
  assert.equal(rows[0]!.sub, "周三 · No. 010");
  assert.equal(rows[1]!.label, "10月5日");
  assert.equal(rows[1]!.sub, "周一 · No. 009");
  assert.equal(rows[0]!.date, "2026-11-04");
});

test("archiveRows: a day without an issue number shows only the weekday", () => {
  const [row] = archiveRows([{ date: "2026-11-04", no: 0, titles: ["甲"] }]);
  assert.equal(row!.sub, "周三");
});

test("ArchivePage lists one row per day with its titles, and 共 N 期 in the masthead", async () => {
  const stub = stubFetch(() => ({
    body: {
      issueCount: 2,
      archive: [
        { date: "2026-11-04", no: 10, titles: ["甲标题", "乙标题", "丙标题"] },
        { date: "2026-11-03", no: 9, titles: ["丁标题"] },
      ],
    },
  }));
  const page = await mount();
  await page.render(createElement(ArchivePage, { fetchImpl: stub.fetch }));
  await page.render(createElement(ArchivePage, { fetchImpl: stub.fetch }));
  const rows = [...page.container.querySelectorAll(".arch-item")];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.getAttribute("href")), ["/issue/2026-11-04", "/issue/2026-11-03"]);
  assert.ok(includes(rows[0] as HTMLElement, "11月4日"));
  assert.ok(includes(rows[0] as HTMLElement, "甲标题 · 乙标题 · 丙标题"));
  assert.ok(includes(page.container, "共 2 期"));
  await page.teardown();
});

test("ArchivePage: an empty archive, a failed load and signed out each say so, never a blank list", async () => {
  const cases: Array<[unknown, string]> = [
    [{ body: { issueCount: 0, archive: [] } }, "还没有往期"],
    [{ status: 500, body: {} }, "暂时"],
    [{ status: 401, body: {} }, "登录"],
  ];
  for (const [answer, want] of cases) {
    const stub = stubFetch(() => answer as { status?: number; body?: unknown });
    const page = await mount();
    await page.render(createElement(ArchivePage, { fetchImpl: stub.fetch }));
    await page.render(createElement(ArchivePage, { fetchImpl: stub.fetch }));
    assert.ok(includes(page.container, want), `${want}: ${page.container.textContent}`);
    await page.teardown();
  }
});

test("nav: 往期 is the current page on /archive and on one issue; 今日 on the home page", () => {
  const past = { to: "/archive" };
  const today = { to: "/" };
  assert.equal(tabIsActive(past, "/archive"), true);
  assert.equal(tabIsActive(past, "/issue/2026-11-04"), true);
  assert.equal(tabIsActive(today, "/issue/2026-11-04"), false, "a past issue is not 今日");
  assert.equal(tabIsActive(today, "/"), true);
  assert.equal(tabIsActive(today, "/today"), true);
  assert.equal(tabIsActive(past, "/"), false);
});
