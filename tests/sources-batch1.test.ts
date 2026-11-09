// 施工第 4 步：采集接入第一批（batch-1）——迁移幂等、入库计数、按 feedUrl 去重、
// 采集健康语义（成功/失败/判重归零）与健康报表 API 的登录隔离。
import { readFileSync } from "node:fs";
import http from "node:http";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { collectSource } from "@topka/backend/sources/collect";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();

// 本地假 RSS feed：两条目，第二次采集（cursor 命中）零新增。
const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>测试源 ${T}</title>
<item><title>条目甲 ${T}</title><link>https://example.com/${T}/a</link><pubDate>Wed, 01 Oct 2026 00:00:00 GMT</pubDate><description>摘要甲。</description></item>
<item><title>条目乙 ${T}</title><link>https://example.com/${T}/b</link><pubDate>Wed, 01 Oct 2026 00:10:00 GMT</pubDate><description>摘要乙。</description></item>
</channel></rss>`;
const feedServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/xml" });
  res.end(FEED_XML);
});
await new Promise<void>((resolve) => feedServer.listen(0, "127.0.0.1", () => resolve()));
const feedPort = (feedServer.address() as { port: number }).port;
const FEED_URL = `http://127.0.0.1:${feedPort}/feed.xml`;

// 从种子文件重算迁移的期望值（与 0041 的插入顺序和去重规则一致）。
const seed = JSON.parse(readFileSync("database/seeds/sources-batch-1.json", "utf8")) as {
  families: Record<string, Array<{ name: string; config: { feedUrl: string } }>>;
};
const seenUrls = new Set<string>();
const expected: Record<string, number> = {};
for (const family of ["rss", "directory", "weibo"]) {
  let n = 0;
  for (const entry of seed.families[family]) {
    if (seenUrls.has(entry.config.feedUrl)) continue;
    seenUrls.add(entry.config.feedUrl);
    n += 1;
  }
  expected[family] = n;
}

const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, config, tags, tier, participation_mode, next_fetch_at)
    VALUES (${'rss-' + T}, ${'测试源 ' + T}, 'rss',
            ${sql.json({ feedUrl: FEED_URL })},
            ARRAY['batch-1', 'rss'], 'T2', 'editorial', now())`;
  await sql`INSERT INTO sources (id, name, kind, config, tags, tier, participation_mode, next_fetch_at)
    VALUES (${'rss-dead-' + T}, ${'死源（端口不通）' + T}, 'rss',
            ${sql.json({ feedUrl: 'http://127.0.0.1:1/feed.xml' })},
            ARRAY['batch-1', 'rss'], 'T2', 'editorial', now())`;
});

after(async () => {
  // 只清理本次夹具（按精确 id）；batch-1 种子行是产品数据，必须保留。
  // 外键顺序：articles → fetch_runs → sources。
  await sql`DELETE FROM articles WHERE source_id IN (${'rss-' + T}, ${'rss-dead-' + T})`;
  await sql`DELETE FROM fetch_runs WHERE source_id IN (${'rss-' + T}, ${'rss-dead-' + T})`;
  await sql`DELETE FROM sources WHERE id IN (${'rss-' + T}, ${'rss-dead-' + T})`;
  await app.close();
  await new Promise<void>((resolve) => feedServer.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

test("batch-1 迁移：按种子去重后的计数入库（imported_from 标记）", async () => {
  const rows = await sql`
    SELECT
      count(*) FILTER (WHERE imported_from = 'batch-1' AND NOT ('directory' = ANY (tags) OR 'weibo' = ANY (tags))) AS rss_n,
      count(*) FILTER (WHERE imported_from = 'batch-1' AND 'directory' = ANY (tags)) AS directory_n,
      count(*) FILTER (WHERE imported_from = 'batch-1' AND 'weibo' = ANY (tags)) AS weibo_n
    FROM sources WHERE imported_from = 'batch-1'`;
  const r = rows[0] as { rss_n: string; directory_n: string; weibo_n: string };
  assert.equal(Number(r.rss_n), expected.rss, `rss 应为 ${expected.rss}`);
  assert.equal(Number(r.directory_n), expected.directory, `directory 应为 ${expected.directory}（跨家族重复 feedUrl 被去重）`);
  assert.equal(Number(r.weibo_n), expected.weibo, `weibo 应为 ${expected.weibo}`);
  // directory 家族 feedUrl 与 rss 家族零重复
  const clash = await sql`
    SELECT count(*) AS n FROM sources a
    WHERE imported_from = 'batch-1' AND 'directory' = ANY (a.tags)
      AND EXISTS (SELECT 1 FROM sources b WHERE imported_from = 'batch-1' AND 'rss' = ANY (b.tags)
                  AND b.config->>'feedUrl' = a.config->>'feedUrl')`;
  assert.equal(Number((clash[0] as { n: string }).n), 0, "跨家族 feedUrl 不应重复");
});

// 本文件的 stub 走回环地址，需要 ALLOW_PRIVATE_NETWORK_FETCH=1（单文件运行）。
  // 全量套件不带该变量运行（上游 SSRF 防护自己的测试要求它关闭），此用例自动跳过。
test("真实读取器：条目入库、判重归零、失败降级", { skip: process.env.ALLOW_PRIVATE_NETWORK_FETCH !== "1" ? "需要 ALLOW_PRIVATE_NETWORK_FETCH=1" : false }, async () => {
  const first = await collectSource(`rss-${T}`, { force: true });
  assert.ok(first.created >= 2, `首采应至少入库 2 条（got ${first.created}，error=${first.error ?? "无"}）`);
  const second = await collectSource(`rss-${T}`, { force: true });
  assert.equal(second.created, 0, "同 cursor 二采应零新增");

  await collectSource(`rss-dead-${T}`, { force: true });
  const healthRow = await sql`SELECT health, fail_count FROM sources WHERE id = ${'rss-dead-' + T}`;
  const h = healthRow[0] as { health: string; fail_count: number };
  assert.equal(h.health, "degraded", "首败应降级为 degraded");
  assert.ok(h.fail_count >= 1);
});

test("健康报表 API：未登录 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/sources/health" });
  assert.equal(res.statusCode, 401);
});
