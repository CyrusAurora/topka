// The publication row is what projects and issues read: a licence revocation or a withdrawal takes an
// item out of the pool, hot_signal material never enters it, the release gate opens on grouping, old
// item links lead to the original only while the item is public, and unchanged republishing writes nothing.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { setVisibility } from "@topka/backend/admin/content";
import { updateSource } from "@topka/backend/admin/sources";
import { upsertMaterial } from "@topka/backend/content/materials";
import { stopBoss } from "@topka/backend/jobs/queue";
import { publishArticle, republishSource } from "@topka/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-publication-${T}`;
const BODY = `FULLTEXT-${T} `.repeat(40);
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test publication', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
/** A selected article with full text and a summary. */
async function article(): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-${n}`, title: `Test ${n}`, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${`标题${n}-${T}`}, ${`SUMMARY-${n}-${T}`}, '理由', 90, true)`;
  return articleId;
}

const released = () => ({ releasedAt: new Date(Date.now() - 60_000) });
const row = async (id: string) =>
  (await sql<{ visibility: string; eligible: boolean; selected: boolean; visible_after: Date | null }[]>`
    SELECT visibility, eligible, selected, visible_after FROM publications WHERE article_id = ${id}`)[0]!;
const original = async (id: string) => {
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  return { status: res.statusCode, url: res.statusCode === 200 ? (JSON.parse(res.body) as { originalUrl: string }).originalUrl : null };
};

test("an old item link leads to the original while the item is public, and nowhere after a withdrawal", async () => {
  const id = await article();
  await publishArticle(id, released());
  assert.deepEqual(await original(id), { status: 200, url: `https://example.com/${T}-${n}` });
  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  assert.equal((await row(id)).visibility, "withdrawn");
  assert.equal((await original(id)).status, 404);
  assert.equal((await original("no-such-item")).status, 404);
});

test("revoking a source's licence takes its articles out of the pool", async () => {
  const id = await article();
  await publishArticle(id, released());
  assert.equal((await row(id)).visibility, "public");

  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${SOURCE}`;
  const patch = { participation_mode: "isolated", site_fulltext: false };
  await updateSource(SOURCE, { patch, version: source!.updated_at.toISOString(), reason: "test" }, "test");
  const [queued] = await sql<{ value: { status: string } }[]>`SELECT value FROM settings WHERE key = ${`republish.source:${SOURCE}`}`;
  assert.equal(queued?.value.status, "queued", "the admin change queues a background republish");

  const result = await republishSource(SOURCE); // what the queued job runs
  assert.ok(result.reduced >= 1);
  assert.equal((await row(id)).visibility, "withdrawn");
  assert.equal((await original(id)).status, 404);

  await sql`UPDATE sources SET participation_mode = 'editorial', site_fulltext = true WHERE id = ${SOURCE}`;
});

test("hot_signal material never enters the pool, even with an imported summary", async () => {
  const SIGNAL = `${SOURCE}-signal`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
            VALUES (${SIGNAL}, 'Test signal', 'rss', 'T1', 'hot_signal', true, '2100-01-01')`;
  const { articleId: signal } = await upsertMaterial({
    sourceId: SIGNAL, url: `https://example.com/${T}-signal`, title: `signal ${T}`, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${signal}, 1, 'replay', 'pass', 'industry', ${`信号-${T}`}, ${`SIGNAL-SUMMARY-${T}`}, 80, false)`;
  await publishArticle(signal);
  assert.deepEqual([(await row(signal)).eligible, (await row(signal)).selected], [false, false]);
  assert.equal((await original(signal)).status, 404);
});

test("the release gate opens when the item is grouped", async () => {
  const id = await article();
  await publishArticle(id);
  const gated = await row(id);
  assert.ok(gated.selected && gated.visible_after! > new Date(), "a fresh selected item waits for grouping");
  await sql`UPDATE articles SET grouped_at = now() WHERE id = ${id}`;
  await publishArticle(id);
  assert.ok((await row(id)).visible_after! <= new Date(), "grouped: released now");
});

test("unchanged republishing preserves freshness, while a URL-only difference in the projection is repaired", async () => {
  const id = await article();
  await publishArticle(id, released());
  const state = async () => (await sql`SELECT xmin::text AS row_version, updated_at, revision, url FROM publications WHERE article_id = ${id}`)[0]!;
  const before = await state();
  const unchanged = await publishArticle(id);
  assert.equal(unchanged!.changed, false);
  assert.deepEqual({ ...await state() }, { ...before }, "no new tuple or freshness timestamp for identical content");

  // An article's URL never changes (migration 0059), so a URL-only difference is a projection
  // written from older data: republishing repairs it.
  const [{ url }] = await sql<{ url: string }[]>`SELECT url FROM articles WHERE id = ${id}`;
  await sql`UPDATE publications SET url = ${`https://example.com/${T}-stale`} WHERE article_id = ${id}`;
  const stale = await state();
  const result = await publishArticle(id);
  assert.equal(result!.changed, false, "URL is deliberately outside the presentation fingerprint");
  const changed = await state();
  assert.equal(changed.url, url);
  assert.notEqual(changed.row_version, stale.row_version);
  assert.ok(changed.updated_at >= before.updated_at);
  assert.equal(changed.revision, before.revision);
});
