// 拆分后误还原: once an editor splits a report off its fact (detachFromFact), no automatic path may put
// it back — not a revision, an explicit or pending regroup, a sibling's regroup, a new report joining
// the fact, a story consolidation or a republish — even when the model insists it is the same
// occurrence. The count of restored reports is the grouping eval's split-restore number
// (docs/quality.md); the run is written to .data/eval/split-restore.json for `npm run eval`.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { REPO_ROOT } from "@topka/backend/config";
import { closeDb, sql } from "@topka/backend/db";
import { detachFromFact } from "@topka/backend/admin/content";
import { upsertMaterial } from "@topka/backend/content/materials";
import { consolidate, groupArticle } from "@topka/backend/events/group";
import { stopBoss } from "@topka/backend/jobs/queue";
import { publishArticle } from "@topka/backend/publication/publish";

const T = tag();
const SOURCE = `test-split-${T}`;
const FACT_TITLE = `拆分测试${T}发布新机器人`;

// The model always sees the same occurrence, for every candidate, with full confidence: the worst case.
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const user = body.messages[1]!.content;
  const pair = user.includes("报道 A");
  const ids = [...user.matchAll(/【候选 (C\d+)】/g)].map((m) => m[1]!);
  const answer = pair
    ? { a: "发布", b: "发布", relation: "SAME_OCCURRENCE", difference: "", confidence: 1 }
    : { query: "发布新机器人", decisions: (ids.length ? ids : ["C1"]).map((id) => ({ id, relation: "SAME_OCCURRENCE", confidence: 1, note: "" })) };
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";

let storyId: number;
let factId: number;

async function report(suffix: string) {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/split-${T}-${suffix}`, title: `Robot launch ${T} ${suffix}`, bodyText: "A new robot.", bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${FACT_TITLE}, '摘要', 80, false, ${sql.json({ fact: { title: FACT_TITLE, subject: "测试", action: "发布", object: "机器人" } })})`;
  await publishArticle(articleId);
  return articleId;
}

/** Whether a split report is back in a fact or a story (membership, heat evidence or its publication). */
async function restored(id: string): Promise<boolean> {
  const [m] = await sql`SELECT 1 FROM fact_articles WHERE article_id = ${id} LIMIT 1`;
  const [s] = await sql`SELECT 1 FROM story_signals WHERE article_id = ${id} LIMIT 1`;
  const [p] = await sql<{ fact_id: number | null }[]>`SELECT fact_id FROM publications WHERE article_id = ${id}`;
  return Boolean(m || s || p?.fact_id);
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test split', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${FACT_TITLE}, now(), now()) RETURNING id`;
  storyId = story!.id;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}`}, ${storyId}, ${FACT_TITLE}) RETURNING id`;
  factId = fact!.id;
  const first = await report("anchor");
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${first}, 'report')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("a report split off its fact stays split on every automatic path", async () => {
  // Three reports join the fact, then an editor splits each of them off.
  const split: string[] = [];
  for (const s of ["a", "b", "c"]) {
    const id = await report(s);
    const r = await groupArticle(id);
    assert.equal(r.verdict, "same-fact", "the stub joins every report to the fact");
    split.push(id);
  }
  const sibling = await report("sibling");
  await groupArticle(sibling);
  for (const id of split) {
    await detachFromFact(id, "different robot", "test");
    assert.equal(await restored(id), false, "the split itself detaches the report");
  }

  const paths: Array<[string, () => Promise<unknown>]> = [
    ["revision (grouping again)", async () => { for (const id of split) await groupArticle(id); }],
    ["explicit regroup", async () => { for (const id of split) await groupArticle(id, { force: true }); }],
    ["pending regroup", async () => {
      for (const id of split) {
        await sql`INSERT INTO regroup_pending (article_id) VALUES (${id}) ON CONFLICT DO NOTHING`;
        await groupArticle(id);
      }
    }],
    ["sibling regroup", () => groupArticle(sibling, { force: true })],
    ["new report joins the fact", async () => groupArticle(await report("late"))],
    ["story consolidation", () => consolidate([storyId])],
    ["republish", async () => { for (const id of split) await publishArticle(id); }],
  ];
  const results: Array<{ path: string; restored: number }> = [];
  for (const [name, run] of paths) {
    await run();
    let n = 0;
    for (const id of split) if (await restored(id)) n++;
    results.push({ path: name, restored: n });
  }
  const total = results.reduce((t, r) => t + r.restored, 0);
  const out = path.join(REPO_ROOT, ".data/eval");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "split-restore.json"), JSON.stringify({ splitReports: split.length, paths: results, restored: total, at: new Date().toISOString() }, null, 2));
  assert.deepEqual(results.filter((r) => r.restored), [], "no path restores a split report");
});
