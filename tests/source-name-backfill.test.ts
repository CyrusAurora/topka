// 0041 inserted three batch-1 rows with an empty name, and two of them pointed at an http address that now
// answers 500. 0056 fills only the blank names and moves only a dead address to https, so an operator's
// own edits survive. This runs the migration's SQL again, against throwaway rows.
import { readFileSync } from "node:fs";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";

const T = tag();
const BLANK = `rss-blank-${T}`;    // a row as 0041 leaves it: no name
const HTTP = `rss-http-${T}`;      // an http address nothing else holds
const BOTH = `rss-both-${T}`;      // an http address whose https twin already exists
const MIGRATION = readFileSync("database/migrations/0056_source_names_and_https.sql", "utf8");
const HTTPS_TWIN = "https://plink.anyfeeder.com/weixin/duhaoshu";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, config, tags, tier, participation_mode, enabled) VALUES
    (${BLANK}, '', 'rss', ${sql.json({ feedUrl: "https://draveness.me/feed.xml" })}, ARRAY['batch-1'], 'T2', 'hot_signal', false),
    (${HTTP}, ${`http 源 ${T}`}, 'rss', ${sql.json({ feedUrl: `http://plink.anyfeeder.com/weixin/only-http-${T}` })}, ARRAY[]::text[], 'T2', 'hot_signal', false),
    (${BOTH}, ${`https 已存在的 http 源 ${T}`}, 'rss', ${sql.json({ feedUrl: HTTPS_TWIN.replace("https://", "http://") })}, ARRAY[]::text[], 'T2', 'hot_signal', false)`;
});

after(async () => {
  await sql`DELETE FROM sources WHERE id IN (${BLANK}, ${HTTP}, ${BOTH})`;
  await closeDb();
});

const row = async (id: string) => (await sql`SELECT name, config->>'feedUrl' AS feed FROM sources WHERE id = ${id}`)[0] as { name: string; feed: string } | undefined;

test("a nameless batch-1 source gets the feed's own name, and re-running changes nothing", async () => {
  await sql.begin((tx) => tx.unsafe(MIGRATION));
  assert.equal((await row(BLANK))?.name, "面向信仰编程");
  await sql.begin((tx) => tx.unsafe(MIGRATION));
  assert.equal((await row(BLANK))?.name, "面向信仰编程");
});

test("no source in the migrated database is left without a name", async () => {
  const rows = await sql`SELECT id FROM sources WHERE trim(coalesce(name, '')) = ''`;
  assert.equal(rows.length, 0, "every seeded source has a name");
});

test("a dead http address moves to https, unless another source already holds the https one", async () => {
  await sql.begin((tx) => tx.unsafe(MIGRATION));
  assert.equal((await row(HTTP))?.feed, `https://plink.anyfeeder.com/weixin/only-http-${T}`);
  // The https twin is a real seeded source: moving would leave two rows on one feed, so it stays put.
  assert.equal((await row(BOTH))?.feed, HTTPS_TWIN.replace("https://", "http://"));
});

test("a seeded http address is gone after the migration", async () => {
  const rows = await sql`SELECT id FROM sources WHERE config->>'feedUrl' LIKE 'http://plink.anyfeeder.com/%' AND id NOT IN (${BOTH})`;
  assert.equal(rows.length, 0);
});

test("an operator's own name on a batch-1 row is never overwritten", async () => {
  await sql`UPDATE sources SET name = ${"我改过的名字" + T} WHERE id = ${BLANK}`;
  await sql.begin((tx) => tx.unsafe(MIGRATION));
  assert.equal((await row(BLANK))?.name, "我改过的名字" + T);
});
