// Magazine Today: three cards, expand/copy chrome, no score in the reading text, honest signed-out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { MagazineToday } from "../app/features/magazine/today.ts";
import { cardRows, type MagazineIssuePayload, type TodayView } from "../app/features/magazine/view.ts";
import { includes, mount, stubFetch } from "./harness.ts";

const issuePayload: MagazineIssuePayload = {
  projects: [{ id: "p1", slug: "embodied", target: "具身智能" }],
  issue: {
    date: "2026-10-27",
    no: 12,
    fixedAt: "2026-10-27T00:00:00.000Z",
    hero: true,
    ready: true,
    items: [
      {
        id: "a1", position: 1, title_a: "标题甲", title_b: "续半", core_a: "核心价值一", core_b: "",
        summary: "展开后的摘要一", tag: "人形", source: "arXiv", url: "https://example.org/1",
        score: 91.5, project: { id: "p1", slug: "embodied", target: "具身智能" },
        publishedAt: "2026-10-26T12:00:00.000Z", listedAt: "2026-10-27T00:00:00.000Z",
        hasCopy: true, overBudget: false,
      },
      {
        id: "a2", position: 2, title_a: "标题乙", title_b: "", core_a: "核心价值二", core_b: "补一句",
        summary: "展开后的摘要二", tag: "操作", source: "TechCrunch", url: "https://example.org/2",
        score: 77, project: { id: "p1", slug: "embodied", target: "具身智能" },
        publishedAt: null, listedAt: "2026-10-27T00:10:00.000Z",
        hasCopy: true, overBudget: false,
      },
      {
        id: "a3", position: 3, title_a: "标题丙", title_b: "", core_a: "核心价值三", core_b: "",
        summary: "展开后的摘要三", tag: "模型", source: "The Decoder", url: "https://example.org/3",
        score: 88, project: { id: "p1", slug: "embodied", target: "具身智能" },
        publishedAt: "2026-10-27T01:00:00.000Z", listedAt: "2026-10-27T01:05:00.000Z",
        hasCopy: true, overBudget: false,
      },
    ],
  },
  opened: [],
  archive: [{ date: "2026-10-26", no: 11, titles: ["昨天"] }],
  notice: "AI 生成摘要，以原文为准。",
};

test("cardRows keep titles and cores and never surface the internal score", () => {
  const view: TodayView = {
    phase: "ready",
    day: "2026-10-27",
    projects: issuePayload.projects,
    issue: issuePayload.issue,
    opened: [],
    archive: issuePayload.archive ?? [],
    notice: issuePayload.notice ?? "",
  };
  const rows = cardRows(view, new Date("2026-10-27T08:00:00+08:00"));
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.title, "标题甲 续半");
  assert.equal(rows[0]!.core, "核心价值一");
  assert.equal(rows[1]!.core, "核心价值二 补一句");
  const dumped = JSON.stringify(rows);
  assert.ok(!/"score"\s*:/.test(dumped), "CardRow must not carry score");
  assert.ok(!dumped.includes("91.5") && !dumped.includes("77") && !dumped.includes("88"));
});

test("MagazineToday shows three cards without the internal scores; signed-out is honest", async () => {
  const stub = stubFetch((url) => {
    if (url === "/api/me/today") return { body: issuePayload };
    return { status: 404, body: {} };
  });
  const page = await mount();
  await page.render(createElement(MagazineToday, { fetchImpl: stub.fetch }));
  await page.render(createElement(MagazineToday, { fetchImpl: stub.fetch }));
  for (const text of ["标题甲", "续半", "核心价值一", "标题乙", "核心价值二", "标题丙", "往期"]) {
    assert.ok(includes(page.container, text), text);
  }
  const text = page.container.textContent ?? "";
  assert.ok(!text.includes("91.5") && !text.includes("91") && !/\b77\b/.test(text) && !/\b88\b/.test(text), text);
  await page.teardown();

  const out = stubFetch((url) => (url === "/api/me/today" ? { status: 401, body: {} } : { status: 404, body: {} }));
  const page2 = await mount();
  await page2.render(createElement(MagazineToday, { fetchImpl: out.fetch }));
  await page2.render(createElement(MagazineToday, { fetchImpl: out.fetch }));
  assert.ok(includes(page2.container, "登录后就能看到你的今日"), page2.container.textContent);
  const hrefs = [...page2.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  assert.ok(hrefs.includes("/login") && hrefs.includes("/register"), "signed out: both doors are offered");
  await page2.teardown();
});
