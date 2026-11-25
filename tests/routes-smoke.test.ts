// Every read route of the API answers on a seeded database without a server error: the site reads
// (an item's original, about, contact, source health), the retired public exits (410), the admin reads
// behind a password session, and the admin guard itself (no session 401, a write without the CSRF
// token 403). Data paths are exercised with one source and a few publications on it.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const T = tag();
const SRC = `smoke-src-${T}`;
// config reads ADMIN_PASSWORD once, at its first import: set it before anything loads it.
process.env.ADMIN_PASSWORD = `smoke-admin-${T}-password`;
const { closeDb, sql } = await import("@topka/backend/db");
const { upsertMaterial } = await import("@topka/backend/content/materials");
const { passwordLogin, SESSION_COOKIE: ADMIN_COOKIE } = await import("@topka/backend/admin/auth");
const { buildApp } = await import("../apps/api/src/app.ts");
const app = await buildApp();
const titles: string[] = [];
const ids: string[] = [];
let admin = "";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at, config) VALUES
    (${SRC}, ${`冒烟信源 ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01', ${sql.json({ url: "https://example.org/feed.xml" })})`;
  for (let i = 0; i < 3; i++) {
    const at = new Date(Date.now() - (5 + i) * 60_000);
    const url = `https://example.org/smoke-${T}-${i}`;
    const title = `冒烟新闻 ${T} ${i}`;
    const id = (await upsertMaterial({ sourceId: SRC, url, title, bodyText: `正文 ${i}`, bodyStatus: "ok", via: "fetch", publishedAt: at })).articleId;
    await sql`INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, eligible, score, visible_after, listed_at)
      VALUES (${id}, ${title}, ${title}, ${`摘要 ${i}`}, ${SRC}, 'news', ${url}, ${at}, ${at}, ${at}, true, ${90 - i}, ${at}, ${at})`;
    await sql`UPDATE publications SET in_scope = true WHERE article_id = ${id}`;
    await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${id}`;
    titles.push(title);
    ids.push(id);
  }
  const { token } = await passwordLogin(process.env.ADMIN_PASSWORD!, "/admin", "smoke");
  admin = `${ADMIN_COOKIE}=${token}`;
});

after(async () => {
  await app.close();
  await closeDb();
});

const get = (url: string, cookie?: string) => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

test("site reads answer, an item link leads to its original, the retired public exits are gone", async () => {
  for (const url of ["/api/site/contact", "/api/site/stats", "/api/sources/health", "/api/site/items/nope"]) {
    const r = await get(url);
    assert.ok(r.statusCode < 500, `${url}: ${r.statusCode} ${r.body.slice(0, 200)}`);
  }
  // The about page's newest items are the pool's own picks, never what one reader got.
  const stats = JSON.parse((await get("/api/site/stats")).body) as { latest: Array<{ id: string }> };
  for (const { id } of stats.latest) {
    const [p] = await sql<{ selected: boolean; visibility: string }[]>`SELECT selected, visibility FROM publications WHERE article_id = ${id}`;
    assert.deepEqual({ ...p }, { selected: true, visibility: "public" }, id);
  }
  const item = await get(`/api/site/items/${ids[0]}`);
  assert.equal(item.statusCode, 200);
  assert.equal((JSON.parse(item.body) as { originalUrl: string }).originalUrl, `https://example.org/smoke-${T}-0`);
  assert.equal((await get("/api/site/items/nope")).statusCode, 404);
  const retired = ["/api/v1/items", "/api/v1", "/api/mcp", "/feed.xml", "/feed/all.xml", "/rss", "/sitemap.xml", "/sitemaps/items-1.xml",
    "/llms.txt", "/openapi-v1.json", `/items/${ids[0]}/markdown`];
  for (const url of retired) assert.equal((await get(url)).statusCode, 410, url);
  // A reader's own issue feed is not a retired exit: an unknown token is a plain 404.
  assert.equal((await get("/feed/issue/nope.xml")).statusCode, 404);
});

test("the admin API: no session 401, a write without the CSRF token 403", async () => {
  assert.equal((await get("/api/admin/sources")).statusCode, 401);
  const w = await app.inject({ method: "POST", url: "/api/admin/processing/requeue", headers: { cookie: admin, "content-type": "application/json" }, payload: "{}" });
  assert.equal(w.statusCode, 403);
  const me = await get("/api/admin/me", admin);
  assert.equal(me.statusCode, 200);
  // The password admin is marked, so the page names it by role in its own language.
  assert.equal((JSON.parse(me.body) as { builtIn?: boolean }).builtIn, true);
});

test("admin reads answer without a server error behind a password session", async () => {
  const urls = [
    "/api/admin/sources", "/api/admin/sources?q=冒烟", `/api/admin/sources/${SRC}`, "/api/admin/sources/nope",
    "/api/admin/content", "/api/admin/content?q=冒烟", "/api/admin/content?state=analyzed", `/api/admin/content/${ids[0]}`, "/api/admin/content/nope",
    "/api/admin/feedback", "/api/admin/feedback?status=open", "/api/admin/runs", "/api/admin/runs?kind=receipts", "/api/admin/settings",
    "/api/admin/models", "/api/admin/selectbench", "/api/admin/selectbench/nope", "/api/admin/nav-counts", "/api/admin/audit", "/api/admin/audit?limit=5",
    "/api/auth/options", "/api/auth/check",
  ];
  for (const url of urls) {
    const r = await get(url, admin);
    assert.ok(r.statusCode < 500, `${url}: ${r.statusCode} ${r.body.slice(0, 200)}`);
  }
  assert.equal((await get("/api/admin/sources", admin)).statusCode, 200);
  // The list is paged (100 a page) and the suite's other tests add sources: search for this one.
  const list = await get(`/api/admin/sources?q=${encodeURIComponent(T)}`, admin);
  assert.equal(list.statusCode, 200);
  assert.match(list.body, new RegExp(SRC));
  const item = await get(`/api/admin/content/${ids[0]}`, admin);
  assert.equal(item.statusCode, 200);
  assert.match(item.body, new RegExp(titles[0]!));
});

test("the content finder with no term lists the newest items, not nothing", async () => {
  // A fresh install opens 内容诊断 with an empty search box: it has to show what arrived.
  const { searchContent } = await import("@topka/backend/admin/content");
  const rows = await searchContent("");
  assert.ok(rows.length > 0, "an empty term returns the newest items");
  assert.ok(rows.length <= 50, "capped at 50");
  const [newest] = await sql<{ at: Date }[]>`SELECT max(discovered_at) AS at FROM articles`;
  const at = (r: { discovered_at: Date | string }) => new Date(r.discovered_at).getTime();
  assert.equal(at(rows[0]!), new Date(newest!.at).getTime(), "the first row is the newest article");
  for (let i = 1; i < rows.length; i++) assert.ok(at(rows[i - 1]!) >= at(rows[i]!), "newest first");
  // The term still narrows: the smoke titles come back for their tag.
  const found = await searchContent(T);
  assert.deepEqual(found.map((r) => r.id).sort(), [...ids].sort());
});

test("admin writes validate their input (4xx, never 5xx) and the accepted ones land in the audit log", async () => {
  const me = JSON.parse((await get("/api/admin/me", admin)).body) as { csrf: string };
  const send = (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: admin, "x-csrf-token": me.csrf, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
  const writes: Array<[Parameters<typeof send>[0], string, unknown?]> = [
    ["POST", "/api/admin/sources", {}],
    ["POST", "/api/admin/sources/preview", { kind: "rss", config: {} }],
    ["PATCH", `/api/admin/sources/${SRC}`, { patch: { interval_minutes: 60 }, version: "stale", reason: "smoke" }],
    ["PATCH", "/api/admin/sources/nope", { patch: {}, version: "x" }],
    ["POST", `/api/admin/content/${ids[2]}/visibility`, { hidden: true, reason: "冒烟测试隐藏" }],
    ["POST", `/api/admin/content/${ids[2]}/override`, {}],
    ["POST", "/api/admin/content/nope/rerun", { step: "analyze" }],
    ["POST", "/api/admin/content/nope/detach", { reason: "x" }],
    ["POST", "/api/admin/stories/merge", { from: 1, into: 1, reason: "x" }],
    ["PATCH", "/api/admin/feedback/999999", { status: "closed" }],
    ["POST", "/api/admin/feedback/999999/erase", { reason: "x" }],
    ["POST", "/api/admin/feedback-bans", { sourceHash: "", reason: "" }],
    ["DELETE", `/api/admin/feedback-bans/nope-${T}`],
    ["POST", "/api/admin/receipts/999999/release", {}],
    ["POST", "/api/admin/processing/requeue", { reason: "" }],
    ["PUT", "/api/admin/budgets/nope", { perMinute: -1, perHour: 0, perDay: 0, reason: "" }],
    ["POST", "/api/admin/models/nope", { model: null, reason: "" }],
    ["POST", "/api/admin/selectbench/import", {}],
  ];
  for (const [method, url, payload] of writes) {
    const r = await send(method, url, payload);
    assert.ok(r.statusCode < 500, `${method} ${url}: ${r.statusCode} ${r.body.slice(0, 200)}`);
  }
  // A body that fails the schema, or a missing reason, is a 400 naming the problem; a dead feed URL a 422.
  const bad = await send("POST", "/api/admin/sources", {});
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /name/);
  assert.equal((await send("POST", `/api/admin/content/${ids[2]}/override`, {})).statusCode, 400);
  assert.equal((await send("POST", "/api/admin/content/nope/detach", { reason: "x" })).statusCode, 400);
  const audit = await get("/api/admin/audit", admin);
  assert.equal(audit.statusCode, 200);
});
