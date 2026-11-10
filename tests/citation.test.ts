// Citation completeness (quality/citation.ts): every issue card and selected publication must lead
// back to a public publication with a working link, a source name, a time, its own analysis and, for
// issue cards, the receipt of the written copy. Planted broken chains are found and named.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { checkCitations, problemsOf } from "@topka/backend/quality/citation";

const T = tag();
after(closeDb);

test("problem names for each broken link of the chain", () => {
  const ok = { kind: "issue" as const, article_id: "a", has_pub: true, public: true, url: "https://x.example/1", source_name: "X", published_at: new Date(), analysis_ok: true, copy_ok: true };
  assert.deepEqual(problemsOf(ok), []);
  assert.deepEqual(problemsOf({ ...ok, has_pub: false }), ["no-publication"]);
  assert.deepEqual(problemsOf({ ...ok, public: false, url: "x", source_name: " ", published_at: null, analysis_ok: false, copy_ok: false }),
    ["not-public", "no-link", "no-source", "no-time", "no-analysis", "no-copy-receipt"]);
  assert.deepEqual(problemsOf({ ...ok, kind: "selected", copy_ok: null }), [], "selected publications have no card copy");
});

test("a selected publication without its analysis is reported; one with it is complete", async () => {
  const source = `cit-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES (${source}, ${`UT citation ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  // Listed far in the future (a different moment each run) so `since` sees only these two.
  const at = new Date(Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 1e10));
  const ids: string[] = [];
  for (const i of [1, 2]) {
    const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/cit-${T}/${i}`, title: `cit ${i} ${T}`, bodyText: "text", bodyStatus: "ok", via: "fetch", publishedAt: at });
    await sql`
      INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, selected, score, visible_after, listed_at)
      VALUES (${articleId}, ${`cit ${i}`}, null, 's', ${source}, 'news', ${`https://example.org/cit-${T}/${i}`}, ${at}, ${at}, ${at}, ${at}, true, true, 80, ${at}, ${at})`;
    ids.push(articleId);
  }
  const [an] = await sql<{ id: number }[]>`
    INSERT INTO analyses (article_id, input_revision, origin) VALUES (${ids[0]!}, 1, 'rule') RETURNING id`;
  await sql`UPDATE publications SET analysis_id = ${an!.id} WHERE article_id = ${ids[0]!}`;
  const r = await checkCitations({ since: at }).finally(() => sql`DELETE FROM publications WHERE article_id = ANY(${ids})`);
  assert.equal(r.cards, 2);
  assert.equal(r.complete, 1);
  assert.equal(r.completeRate, 0.5);
  assert.deepEqual(r.broken, [{ kind: "selected", articleId: ids[1], problems: ["no-analysis"] }]);
});
