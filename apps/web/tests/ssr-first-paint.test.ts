// L5: a reader page rendered with its server answers is finished on first paint — no loading line,
// no skeleton, no browser fetch — and the same page without them fetches after mount.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PrefetchContext, type Responses } from "../app/lib/reader-data.ts";
import { MagazineToday, TODAY_PATHS } from "../app/features/magazine/today.ts";
import { ArchivePage, ARCHIVE_PATHS } from "../app/features/magazine/archive.ts";
import { issuePaths, MagazineIssue } from "../app/features/magazine/issue-view.ts";
import { SettingsPage, SETTINGS_PATHS } from "../app/features/settings/settings.ts";
import { tabIsActive } from "../app/components/shell/nav-match.ts";

const item = (n: number) => ({
  id: `a${n}`, position: n, title_a: `标题${n}：`, title_b: "第二半", core_a: "一句话，", core_b: "接着说", summary: "摘要。", tag: "", source: "arXiv",
  url: `https://example.org/${n}`, publishedAt: "2026-11-25T00:00:00Z", listedAt: "2026-11-25T00:00:00Z", score: 80, project: { id: "p", slug: "p1", target: "具身智能" },
});
const issue = { date: "2026-11-25", no: 16, items: [item(1), item(2), item(3)] };
const noFetch = (() => {
  throw new Error("a server-rendered page must not fetch on first paint");
}) as unknown as typeof fetch;
const render = (value: Responses, el: ReturnType<typeof createElement>) => renderToString(createElement(PrefetchContext.Provider, { value }, el));

test("今日 with its server answer: the issue on first paint, titles without a double gap", () => {
  const html = render({ [TODAY_PATHS[0]]: { status: 200, body: { projects: [{ id: "p", slug: "p1", target: "具身智能" }], issue, opened: [], archive: [] } } }, createElement(MagazineToday, { fetchImpl: noFetch }));
  assert.match(html, /标题1：第二半/);
  assert.match(html, /No\. 016/);
  assert.doesNotMatch(html, /aria-busy/);
  assert.doesNotMatch(html, /AI/);
});

test("今日 signed out on the server: the door, not a loading line", () => {
  const html = render({ [TODAY_PATHS[0]]: { status: 401, body: null } }, createElement(MagazineToday, { fetchImpl: noFetch }));
  assert.match(html, /href="\/login"/);
  assert.doesNotMatch(html, /aria-busy/);
});

test("今日 without server answers (the demo, a test): skeleton first, then the browser fetches", () => {
  const html = renderToString(createElement(MagazineToday, { fetchImpl: noFetch }));
  assert.match(html, /aria-busy="true"/);
});

test("往期, a single issue and 设置 render finished from their server answers", () => {
  const archive = render({ [ARCHIVE_PATHS[0]]: { status: 200, body: { archive: [{ date: "2026-11-24", no: 15, titles: ["甲：", "乙"] }], issueCount: 15 } } }, createElement(ArchivePage, { fetchImpl: noFetch }));
  assert.match(archive, /href="\/issue\/2026-11-24"/);
  const one = render({ [issuePaths("2026-11-24")[0]!]: { status: 200, body: { issue: { ...issue, date: "2026-11-24", no: 15 } } } }, createElement(MagazineIssue, { date: "2026-11-24", fetchImpl: noFetch }));
  assert.match(one, /No\. 015/);
  assert.match(one, /标题2：第二半/);
  const answers: Responses = Object.fromEntries(SETTINGS_PATHS.map((p) => [p, { status: 200, body: {} }]));
  answers["/api/auth/me"] = { status: 200, body: { user: { email: "reader@example.com", locale: "zh-CN", timezone: "Asia/Taipei" } } };
  answers["/api/me/model-status"] = { status: 503, body: null };
  answers["/api/projects"] = { status: 200, body: { projects: [{ id: "p", slug: "p1", target: "具身智能", purpose: "x" }] } };
  const settings = render(answers, createElement(SettingsPage, { fetchImpl: noFetch }));
  assert.match(settings, /reader@example\.com/);
  assert.match(settings, /href="\/projects\/p1"/, "a project links to its page under /projects");
});

test("a project's page sits under 设置 in the navigation, not 今日", () => {
  assert.equal(tabIsActive({ to: "/" }, "/projects/p1"), false);
  assert.equal(tabIsActive({ to: "/settings" }, "/projects/p1"), true);
  assert.equal(tabIsActive({ to: "/" }, "/today"), true);
});
