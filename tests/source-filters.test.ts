// Per-source include rules and daily caps (config.includeIfMatches, config.dailyCap): items a source
// filters out or caps are never stored, so nothing downstream (extraction, models) sees them. Bad rules
// are refused before a fetch. The project script binds sources to a registered user's project.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { config } from "@topka/backend/config";
import { closeDb, sql } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { collectSource } from "@topka/backend/sources/collect";
import { unsupportedConfig } from "@topka/backend/sources/config-keys";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";

const run = promisify(execFile);
const T = tag();
let batch = 1;
const titles = [
  "Humanoid whole-body control",
  "A new VLA for manipulation",
  "Weather forecasting with transformers",
  "Vision-Language-Action pruning",
  "Database tuning tips",
  "Humanoid teleoperation study",
  "Another humanoid result",
];
const server = http.createServer((req, res) => {
  const conditional = (req.url ?? "").includes("/etag-");
  const etag = '"cap"';
  if (conditional && req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }
  const items = titles
    .map((title, i) => {
      const type = i === 5 ? "replace" : "new";
      return `<item><title>${title} ${batch} ${T}</title><link>https://example.org/filters-${T}${req.url}/${batch}/${i}</link>` +
        `<description>arXiv:0000.${i} Announce Type: ${type} Abstract: text</description><pubDate>${new Date(Date.now() - i * 1000).toUTCString()}</pubDate></item>`;
    })
    .join("");
  res.writeHead(200, { "content-type": "application/rss+xml", ...(conditional ? { etag } : {}) });
  res.end(`<rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

async function source(id: string, extra: Record<string, unknown>, cursor?: Record<string, unknown>) {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
    VALUES (${id}, ${`Filters ${id}`}, 'rss', ${sql.json({ feedUrl: `${base}/${id}`, ...extra } as never)}, 'T1', 'editorial', ${cursor ? sql.json(cursor as never) : null}, '2100-01-01')`;
}
const stored = async (id: string) =>
  (await sql<{ title: string }[]>`SELECT title FROM articles WHERE source_id = ${id} ORDER BY title`).map((r) => r.title.replace(` ${T}`, ""));
const lastDetail = async (id: string) => (await sql`SELECT detail FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!.detail;

test("an include rule keeps only matching items; title and text rules must both match", async () => {
  const id = `filters-include-${T}`;
  await source(id, { includeIfMatches: { title: "vision-language-action|\\bVLAs?\\b|humanoid", text: "Announce Type: new\\b" } });
  const r = await collectSource(id);
  assert.equal(r.status, "ok");
  assert.equal(r.found, 7);
  assert.deepEqual(await stored(id), ["A new VLA for manipulation 1", "Another humanoid result 1", "Humanoid whole-body control 1", "Vision-Language-Action pruning 1"]);
  assert.deepEqual(await lastDetail(id), { excluded: 3 });
});

test("a daily cap stores at most N new items per UTC day, in listing order, across runs", async () => {
  const id = `filters-cap-${T}`;
  await source(id, { dailyCap: 3, includeIfMatches: { title: "humanoid|vla|vision-language-action" } });
  batch = 2;
  const first = await collectSource(id);
  assert.equal(first.created, 3);
  assert.deepEqual(await lastDetail(id), { excluded: 2, capped: 2 });
  assert.deepEqual(await stored(id), ["A new VLA for manipulation 2", "Humanoid whole-body control 2", "Vision-Language-Action pruning 2"]);
  const [imported] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = ${id} AND backfill_reason = 'first-import'`;
  assert.equal(imported!.n, 3, "the first run is the source's first import");
  batch = 3; // a fresh listing the same day: the first import (history) does not use up the cap
  const second = await collectSource(id);
  assert.equal(second.created, 3);
  batch = 4; // the day's new items do
  const full = await collectSource(id);
  assert.equal(full.created, 0);
  assert.equal((await lastDetail(id)).capped, 5);
  // A day later there is room again.
  await sql`UPDATE articles SET created_at = now() - interval '25 hours' WHERE source_id = ${id}`;
  const third = await collectSource(id);
  assert.equal(third.created, 3);
  assert.equal((await stored(id)).length, 9);
});

test("a capped feed is read again on a later run: no validator is kept while items are capped", async () => {
  const id = `etag-cap-${T}`;
  batch = 5;
  await source(id, { dailyCap: 2, includeIfMatches: { title: "humanoid|vla|vision-language-action" } }, { initializedAt: new Date().toISOString() });
  const first = await collectSource(id);
  assert.equal(first.created, 2);
  assert.deepEqual(await lastDetail(id), { excluded: 2, capped: 3 });
  const [row] = await sql<{ cursor: { rss?: unknown } }[]>`SELECT cursor FROM sources WHERE id = ${id}`;
  assert.equal(row!.cursor.rss, undefined, "a capped feed keeps no validator");
  await sql`UPDATE articles SET created_at = now() - interval '25 hours' WHERE source_id = ${id}`;
  const second = await collectSource(id);
  assert.equal(second.created, 2, "the feed is read again, not answered with 304");
});

test("filtered and capped items never reach processing", async () => {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM articles WHERE source_id LIKE ${`filters-%-${T}`} AND (title ILIKE 'Weather%' OR title ILIKE 'Database%')`;
  assert.equal(row!.n, 0);
});

test("bad rules are refused before any fetch", async () => {
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "x", includeIfMatches: { title: "(" } }), ["includeIfMatches.title (not a regular expression)"]);
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "x", includeIfMatches: { body: "a" } }), ["includeIfMatches.body"]);
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "x", dailyCap: 0 }), ["dailyCap=0"]);
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "x", dailyCap: 2.5 }), ["dailyCap=2.5"]);
  assert.deepEqual(unsupportedConfig("x_search", { query: "from:a", dailyCap: 3 }), ["dailyCap"]);
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "x", dailyCap: 12, includeIfMatches: { title: "robot", text: "new" } }), []);
  const id = `filters-bad-${T}`;
  await source(id, { includeIfMatches: { title: "(" } });
  const r = await collectSource(id);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /unsupported config: includeIfMatches\.title/);
  assert.deepEqual(await stored(id), []);
});

test("the project script binds sources to a registered user's project, idempotently", async () => {
  const email = `owner-${T}@example.com`;
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `test ${T}` })).code;
  await registerWithInvite({ code, email, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.41" });
  const a = `filters-include-${T}`;
  const b = `filters-cap-${T}`;
  const args = ["scripts/create-project.ts", "--owner", email, "--target", `具身智能 ${T}`, "--purpose", "跟踪进展"];
  const first = await run(process.execPath, [...args, "--source", a]);
  assert.match(first.stdout, /已创建项目：project:/);
  assert.match(first.stdout, /绑定信源：1 个/);
  const again = await run(process.execPath, [...args, "--source", a, "--source", b]);
  assert.match(again.stdout, /已存在项目/);
  assert.match(again.stdout, /绑定信源：2 个/);
  await assert.rejects(run(process.execPath, [...args.slice(0, 3)]), (e: { code?: number }) => e.code === 2);
  await assert.rejects(run(process.execPath, ["scripts/create-project.ts", "--owner", `nobody-${T}@example.com`, "--target", "x", "--purpose", "y", "--source", a]), (e: { code?: number }) => e.code === 1);
  await assert.rejects(run(process.execPath, [...args, "--source", `missing-${T}`]), (e: { code?: number }) => e.code === 1);
});
