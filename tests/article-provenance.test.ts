// Source content is append-only (migration 0059): the database refuses to rewrite an article's
// origin or content in place, and to edit or drop its history; the real revision paths (a changed
// listing, an extracted body, an X Article) still work because they add a revision in the same
// transaction.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { identityKeyForUrl } from "@topka/backend/lib/url";

const SOURCE = `test-prov-${tag()}`;
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test provenance', 'rss', '2100-01-01')`;
});
after(() => closeDb());

const REFUSED = /article provenance/;

async function fresh(n: string) {
  const url = `https://example.com/prov-${n}-${tag()}`;
  const r = await upsertMaterial({ sourceId: SOURCE, url, title: `Original ${n}`, bodyText: `original body ${n}`, excerpt: `e ${n}`, via: "fetch" });
  return r.articleId;
}

test("an in-place rewrite of title, body or url is refused", async () => {
  const id = await fresh("rewrite");
  await assert.rejects(sql`UPDATE articles SET title = 'Rewritten' WHERE id = ${id}`, REFUSED);
  await assert.rejects(sql`UPDATE articles SET body_text = 'rewritten body' WHERE id = ${id}`, REFUSED);
  await assert.rejects(sql`UPDATE articles SET body_html = '<p>rewritten</p>' WHERE id = ${id}`, REFUSED);
  await assert.rejects(sql`UPDATE articles SET url = 'https://example.com/elsewhere' WHERE id = ${id}`, REFUSED);
  await assert.rejects(sql`UPDATE articles SET identity_key = 'elsewhere' WHERE id = ${id}`, REFUSED);
  await assert.rejects(sql`UPDATE articles SET source_id = ${SOURCE + "-x"} WHERE id = ${id}`, REFUSED);
  await assert.rejects(sql`UPDATE articles SET excerpt = 'other excerpt' WHERE id = ${id}`, REFUSED);
  await assert.rejects(sql`UPDATE articles SET content_hash = 'forged' WHERE id = ${id}`, REFUSED);
  const [row] = await sql`SELECT title, body_text, revision FROM articles WHERE id = ${id}`;
  assert.deepEqual({ ...row }, { title: "Original rewrite", body_text: "original body rewrite", revision: 1 });
});

test("a new revision without its history row, or a skipped revision number, is refused", async () => {
  const id = await fresh("unrecorded");
  // Bumping the revision is not enough: the commit fails unless article_revisions has the same content.
  await assert.rejects(sql`UPDATE articles SET title = 'Silently changed', revision = revision + 1 WHERE id = ${id}`, REFUSED);
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`UPDATE articles SET title = 'Changed', revision = revision + 1 WHERE id = ${id}`;
      await tx`INSERT INTO article_revisions (article_id, revision, title, body_text) VALUES (${id}, 2, 'Something else', 'original body unrecorded')`;
    }),
    REFUSED,
  );
  await assert.rejects(sql`UPDATE articles SET revision = revision + 2 WHERE id = ${id}`, REFUSED);
  await assert.rejects(sql`UPDATE articles SET revision = revision - 1 WHERE id = ${id}`, REFUSED);
  assert.equal((await sql`SELECT revision FROM articles WHERE id = ${id}`)[0]!.revision, 1);
});

test("a revision recorded in the same transaction is the legitimate path", async () => {
  const id = await fresh("legit");
  await sql.begin(async (tx) => {
    const [r] = await tx<{ revision: number; content_hash: string | null }[]>`
      UPDATE articles SET title = 'Corrected', body_text = 'corrected body', content_hash = 'h2', revision = revision + 1
      WHERE id = ${id} RETURNING revision, content_hash`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text) VALUES (${id}, ${r!.revision}, 'h2', 'Corrected', 'corrected body')`;
  });
  assert.equal((await sql`SELECT revision FROM articles WHERE id = ${id}`)[0]!.revision, 2);
});

test("upsertMaterial still revises a changed listing and keeps every version", async () => {
  const url = `https://example.com/prov-listing-${tag()}`;
  const first = await upsertMaterial({ sourceId: SOURCE, url, title: "Listing v1", excerpt: "one", via: "fetch" });
  const second = await upsertMaterial({ sourceId: SOURCE, url, title: "Listing v2", excerpt: "two", bodyText: "now with a body", via: "fetch" });
  assert.equal(second.revised, true);
  const history = await sql<{ revision: number; title: string }[]>`SELECT revision, title FROM article_revisions WHERE article_id = ${first.articleId} ORDER BY revision`;
  assert.deepEqual(history.map((h) => [h.revision, h.title]), [[1, "Listing v1"], [2, "Listing v2"]]);
});

test("imported history may record its baseline hash and fill an empty excerpt once", async () => {
  const url = `https://example.com/prov-imported-${tag()}`;
  const id = `imp${tag()}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, revision, content_hash, body_text, body_status, processing_state)
            VALUES (${id}, ${SOURCE}, ${identityKeyForUrl(url)}, ${url}, 'Legacy title', now(), now(), 1, NULL, 'legacy body', 'ok', 'analyzed')`;
  const r = await upsertMaterial({ sourceId: SOURCE, url, title: "Legacy title", excerpt: "feed summary", via: "fetch" });
  assert.deepEqual([r.articleId, r.revised], [id, false]);
  const [row] = await sql<{ content_hash: string | null; excerpt: string | null }[]>`SELECT content_hash, excerpt FROM articles WHERE id = ${id}`;
  assert.ok(row!.content_hash, "baseline hash recorded");
  assert.equal(row!.excerpt, "feed summary");
  // ...but only once: the recorded baseline is now as fixed as any other.
  await assert.rejects(sql`UPDATE articles SET excerpt = 'another summary' WHERE id = ${id}`, REFUSED);
  await assert.rejects(sql`UPDATE articles SET content_hash = 'other' WHERE id = ${id}`, REFUSED);
});

test("bookkeeping columns stay writable", async () => {
  const id = await fresh("bookkeeping");
  await sql`UPDATE articles SET processing_state = 'analyzed', processing_attempts = 2, grouped_at = now(), body_status = 'ok',
              raw = '{"k":1}', discovered_at = now() - interval '1 hour', updated_at = now() WHERE id = ${id}`;
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id = ${id}`)[0]!.processing_state, "analyzed");
});

test("history rows cannot be edited or deleted on their own, only with their article", async () => {
  const id = await fresh("history");
  await assert.rejects(sql`UPDATE article_revisions SET title = 'Rewritten history' WHERE article_id = ${id}`, REFUSED);
  await assert.rejects(sql`DELETE FROM article_revisions WHERE article_id = ${id}`, REFUSED);
  assert.equal((await sql`SELECT count(*)::int AS n FROM article_revisions WHERE article_id = ${id}`)[0]!.n, 1);
  // A takedown deletes the article, and its history goes with it.
  await sql`DELETE FROM article_discoveries WHERE article_id = ${id}`;
  await sql`DELETE FROM articles WHERE id = ${id}`;
  assert.equal((await sql`SELECT count(*)::int AS n FROM article_revisions WHERE article_id = ${id}`)[0]!.n, 0);
});
