// Story digests and statuses: the digest is written from the story's public reports (new ones marked
// 【新】 after the first version), not rewritten while the reports and what they say are unchanged,
// rewritten from scratch after an editor's correction; a story without reports or merged away is left
// alone. Statuses follow the latest report: active < 24h, watching < 72h, settled after.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const T = tag();
const SRC = `digest-src-${T}`;
const asked: string[] = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  asked.push(body.messages[body.messages.length - 1]!.content);
  const content = JSON.stringify({ title: `综述标题 ${asked.length}`, digest: `第 ${asked.length} 版综述：量产推进中，订单增加。`, latest: "最新：交付" });
  return { id: `d-${asked.length}`, model: "stub", choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.MODEL_CALLS_ENABLED = "true";
const { closeDb, sql } = await import("@topka/backend/db");
const { upsertMaterial } = await import("@topka/backend/content/materials");
const { composeStoryDigest, refreshStoryStatuses, storyStatusFor } = await import("@topka/backend/events/digest");

let story = 0;
let fact = 0;
async function report(i: number) {
  const at = new Date(Date.now() - (10 - i) * 60_000);
  const url = `https://example.org/digest-${T}-${i}`;
  const id = (await upsertMaterial({ sourceId: SRC, url, title: `报道 ${i}`, bodyText: "正文", bodyStatus: "ok", via: "fetch", publishedAt: at })).articleId;
  await sql`INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, score, visible_after, listed_at, in_scope)
    VALUES (${id}, ${`报道 ${i} ${T}`}, ${`报道 ${i}`}, ${`摘要 ${i}`}, ${SRC}, 'news', ${url}, ${at}, ${at}, ${at}, ${at}, true, 80, ${at}, ${at}, true)`;
  await sql`INSERT INTO fact_articles (fact_id, article_id) VALUES (${fact}, ${id})`;
  return id;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES (${SRC}, ${`综述源 ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  [{ id: story }] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, latest_at) VALUES (gen_random_uuid(), ${`事件 ${T}`}, now()) RETURNING id`;
  [{ id: fact }] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, title, story_id) VALUES (gen_random_uuid(), ${`事实 ${T}`}, ${story}) RETURNING id`;
});

after(async () => {
  await provider.close();
  await closeDb();
});

test("status by the latest report's age", () => {
  const now = Date.now();
  assert.equal(storyStatusFor(null, now), "settled");
  assert.equal(storyStatusFor(new Date(now - 3_600_000), now), "active");
  assert.equal(storyStatusFor(new Date(now - 48 * 3_600_000), now), "watching");
  assert.equal(storyStatusFor(new Date(now - 100 * 3_600_000), now), "settled");
});

test("digest: none without reports; written once per report set; new reports marked; a correction rewrites from scratch", async () => {
  assert.deepEqual(await composeStoryDigest(-1), { updated: false }, "no such story");
  assert.deepEqual(await composeStoryDigest(story), { updated: false }, "no reports yet");
  assert.equal(asked.length, 0);
  await report(1);
  const first = await composeStoryDigest(story);
  assert.deepEqual(first, { updated: true, version: 2 });
  assert.doesNotMatch(asked[0]!, /上一版综述/);
  assert.deepEqual(await composeStoryDigest(story), { updated: false }, "same reports, same content");
  await report(2);
  assert.equal((await composeStoryDigest(story)).updated, true);
  assert.match(asked[1]!, /上一版综述：第 1 版综述/);
  assert.match(asked[1]!, /【新】.*报道 2/);
  assert.doesNotMatch(asked[1]!, /【新】.*报道 1/);
  await sql`UPDATE publications SET summary = '更正后的摘要' WHERE title = ${`报道 1 ${T}`}`;
  assert.equal((await composeStoryDigest(story)).updated, true);
  assert.match(asked[2]!, /经过编辑更正/);
  assert.doesNotMatch(asked[2]!, /上一版综述/);
  const [s] = await sql<{ title: string; digest: string; version: number }[]>`SELECT title, digest, version FROM stories WHERE id = ${story}`;
  assert.deepEqual([s!.title, s!.version], ["综述标题 3", 4]);
  assert.equal((await sql`SELECT 1 FROM story_digests WHERE story_id = ${story}`).length, 3);
  await sql`UPDATE stories SET origin = 'manual' WHERE id = ${story}`;
  await report(3);
  await composeStoryDigest(story);
  assert.equal((await sql<{ title: string }[]>`SELECT title FROM stories WHERE id = ${story}`)[0]!.title, "综述标题 3", "a hand-set title stays");
});

test("refreshStoryStatuses moves statuses with the latest report", async () => {
  const ids = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, latest_at, status) VALUES
    (gen_random_uuid(), 'a', now() - interval '1 hour', 'settled'), (gen_random_uuid(), 'w', now() - interval '48 hours', 'active'),
    (gen_random_uuid(), 's', now() - interval '100 hours', 'active') RETURNING id`;
  assert.ok((await refreshStoryStatuses()).updated >= 3);
  const rows = await sql<{ status: string }[]>`SELECT status FROM stories WHERE id IN ${sql(ids.map((r) => r.id))} ORDER BY id`;
  assert.deepEqual(rows.map((r) => r.status), ["active", "watching", "settled"]);
});
