// The observation ledger (master design 3.3, 4 测试策略 3, 8.1 出处不可变): the write path has four
// outcomes and nothing else — created (new, or `changed`: a later version appended as a revision),
// existing, conflict (an older version with other content: refused, recorded, nothing overwritten),
// failed (no provenance, or a write that does not read back: typed, recorded, nothing stored); the
// pipeline entrances count them; a withdrawal is an appended record (never an edit or a delete), the
// latest record is the state, a withdrawn observation leaves the pool and new issues but stays
// readable as retracted material; and the database refuses rewriting any of this history.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const T = tag();
process.env.ADMIN_PASSWORD = `ledger-admin-${T}-password`;
const { closeDb, sql } = await import("@topka/backend/db");
const { MaterialRefused, recordMaterial, upsertMaterial, emptyLedgerCounts, countOutcome } = await import("@topka/backend/content/materials");
const { articleHistory, ledgerStates, recordWithdrawal, WithdrawalInvalid } = await import("@topka/backend/content/withdrawals");
const { ingestItems } = await import("@topka/backend/ingest/items");
const { publishArticle } = await import("@topka/backend/publication/publish");
const { createInvite } = await import("@topka/backend/accounts/invite");
const { registerWithInvite } = await import("@topka/backend/accounts/register");
const { SESSION_COOKIE } = await import("@topka/backend/accounts/session");
const { createProject } = await import("@topka/backend/projects/create-project");
const { issueCandidates, readIssue } = await import("@topka/backend/projects/issues");
const { passwordLogin, SESSION_COOKIE: ADMIN_COOKIE } = await import("@topka/backend/admin/auth");
const { stopBoss } = await import("@topka/backend/jobs/queue");
const { buildApp } = await import("../apps/api/src/app.ts");

const SRC = `ledger-src-${T}`;
const MIRROR = `ledger-mirror-${T}`;
const EXT = `ledger-ext-${T}`;
const app = await buildApp();
let n = 0;
const url = (k = ++n) => `https://example.org/ledger-${T}/${k}`;
const report = (u: string, extra: Record<string, unknown> = {}) => ({ sourceId: SRC, url: u, title: `Title ${T}`, excerpt: "Summary.", via: "fetch" as const, publishedAt: new Date(), ...extra });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES
    (${SRC}, ${`Ledger ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01'),
    (${MIRROR}, ${`Mirror ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => {
  await app.close();
  // The ingest test queued extraction: stop the queue client, or the process stays up.
  await stopBoss();
  await closeDb();
});

test("created, existing and created-changed: a correction is a new revision, the earlier one kept", async () => {
  const u = url();
  const first = await recordMaterial(report(u, { sourceUpdatedAt: new Date("2026-11-01T00:00:00Z") }));
  assert.deepEqual([first.state, first.changed, first.code, first.created, first.revised], ["created", false, null, true, false]);
  const again = await recordMaterial(report(u, { sourceUpdatedAt: new Date("2026-11-01T00:00:00Z") }));
  assert.deepEqual([again.state, again.articleId], ["existing", first.articleId], "the same report is no new observation");
  const mirrored = await recordMaterial({ ...report(u), sourceId: MIRROR, title: `Mirror rendering ${T}` });
  assert.equal(mirrored.state, "existing", "another source listing it is a discovery only");
  const fixed = await recordMaterial(report(u, { title: `Title corrected ${T}`, sourceUpdatedAt: new Date("2026-11-02T00:00:00Z") }));
  assert.deepEqual([fixed.state, fixed.changed, fixed.revised, fixed.articleId], ["created", true, true, first.articleId]);
  // An equal version time with other content is a correction too: most feeds never move `updated`.
  const sameTime = await recordMaterial(report(u, { title: `Title corrected twice ${T}`, sourceUpdatedAt: new Date("2026-11-02T00:00:00Z") }));
  assert.deepEqual([sameTime.state, sameTime.changed], ["created", true]);
  const revs = await sql<{ revision: number; title: string; version_marker: Date | null }[]>`SELECT revision, title, version_marker FROM article_revisions WHERE article_id = ${first.articleId} ORDER BY revision`;
  assert.deepEqual(revs.map((r) => [r.revision, r.title]), [[1, `Title ${T}`], [2, `Title corrected ${T}`], [3, `Title corrected twice ${T}`]]);
  assert.equal(revs[1]!.version_marker?.toISOString(), "2026-11-02T00:00:00.000Z", "each revision keeps the source's version time");
  assert.equal((await ledgerStates([first.articleId!])).get(first.articleId!)?.state, "corrected");
});

test("conflict: other content under an older version time is refused and kept beside the observation, never over it", async () => {
  const u = url();
  const first = await recordMaterial(report(u, { sourceUpdatedAt: new Date("2026-11-05T00:00:00Z") }));
  const stale = report(u, { title: `Stale copy ${T}`, excerpt: "Old summary.", sourceUpdatedAt: new Date("2026-11-03T00:00:00Z") });
  const refused = await recordMaterial(stale);
  assert.deepEqual([refused.state, refused.code, refused.articleId, refused.created, refused.revised], ["conflict", "identity-conflict", first.articleId, false, false]);
  const [stored] = await sql<{ title: string; revision: number }[]>`SELECT title, revision FROM articles WHERE id = ${first.articleId}`;
  assert.deepEqual({ ...stored }, { title: `Title ${T}`, revision: 1 }, "nothing overwritten");
  assert.equal((await recordMaterial(stale)).state, "conflict", "the same stale copy again is refused again");
  const rows = await sql`SELECT state, code, title, excerpt, stored_revision, version_marker, stored_marker FROM observation_rejections WHERE article_id = ${first.articleId}`;
  assert.equal(rows.length, 1, "and recorded once");
  assert.deepEqual([rows[0]!.title, rows[0]!.excerpt, rows[0]!.stored_revision], [`Stale copy ${T}`, "Old summary.", 1]);
  const history = await articleHistory(first.articleId!);
  assert.deepEqual(history!.conflicts.map((c) => c.title), [`Stale copy ${T}`], "the conflicting original can be opened");
  // A version seen before is no conflict, whatever its time: it is the same observation.
  assert.equal((await recordMaterial(report(u, { sourceUpdatedAt: new Date("2026-11-01T00:00:00Z") }))).state, "existing");
});

test("failed: a report without provenance is a typed failure, recorded, nothing stored; upsertMaterial throws on it", async () => {
  const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = ${SRC}`)[0]!.n;
  const cases = [
    report("not a url"),
    report("ftp://example.org/file"),
    { ...report(url()), sourceId: "" },
    { ...report(url()), sourceId: `ledger-unknown-${T}` },
  ];
  for (const c of cases) {
    const r = await recordMaterial(c);
    assert.deepEqual([r.state, r.code, r.articleId], ["failed", "missing-provenance", null], JSON.stringify(c.url) + c.sourceId);
  }
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id = ${SRC}`)[0]!.n, before);
  const [{ k }] = await sql<{ k: number }[]>`SELECT count(*)::int AS k FROM observation_rejections WHERE code = 'missing-provenance' AND (source_id IN (${SRC}, ${`ledger-unknown-${T}`}) OR (source_id IS NULL AND url LIKE ${`https://example.org/ledger-${T}/%`}))`;
  assert.equal(k, 4);
  await assert.rejects(upsertMaterial(report("not a url")), (e: unknown) => e instanceof MaterialRefused && e.result.code === "missing-provenance");
});

test("failed: a write that does not read back as written is rolled back and recorded as preservation-failed", async () => {
  await sql.unsafe(`CREATE OR REPLACE FUNCTION ledger_test_garble() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.source_id = '${SRC}' AND NEW.title LIKE 'Garble%' THEN NEW.title := NEW.title || ' (garbled)'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ledger_test_garble BEFORE INSERT ON articles FOR EACH ROW EXECUTE FUNCTION ledger_test_garble()`);
  const u = url();
  try {
    const r = await recordMaterial(report(u, { title: `Garble ${T}` }));
    assert.deepEqual([r.state, r.code, r.articleId], ["failed", "preservation-failed", null]);
  } finally {
    await sql.unsafe(`DROP TRIGGER ledger_test_garble ON articles`);
    await sql.unsafe(`DROP FUNCTION ledger_test_garble()`);
  }
  assert.equal((await sql`SELECT 1 FROM articles WHERE url = ${u}`).length, 0, "nothing of it was kept");
  const [row] = await sql`SELECT detail FROM observation_rejections WHERE code = 'preservation-failed' AND url = ${u}`;
  assert.match(String(row!.detail), /title/);
});

test("the pipeline counts the four outcomes; an external report of a removal appends a withdrawal", async () => {
  const u1 = url();
  const first = await ingestItems({ sourceId: EXT, items: [{ title: "One", url: u1 }, { title: "Two", url: url() }, { title: "No address" }, { title: "Bad", url: "nope" }] });
  assert.deepEqual(first.ledger, { created: 2, changed: 0, existing: 0, conflict: 0, failed: 2 });
  const again = await ingestItems({ sourceId: EXT, items: [{ title: "One", url: u1 }] });
  assert.deepEqual(again.ledger, { ...emptyLedgerCounts(), existing: 1 });
  const gone = await ingestItems({ sourceId: EXT, items: [{ url: u1, withdrawn: true, withdrawnReason: "post deleted by its author" }, { url: url(), withdrawn: true }] });
  assert.equal(gone.withdrawn, 1, "an unknown item's removal is ignored");
  const [art] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE url = ${u1}`;
  const state = (await ledgerStates([art!.id])).get(art!.id)!;
  assert.deepEqual([state.state, state.withdrawal?.basis, state.withdrawal?.reason], ["retracted-material", "source-removed", "post deleted by its author"]);
  assert.equal((await ingestItems({ sourceId: EXT, items: [{ url: u1, withdrawn: true }] })).withdrawn, 0, "already withdrawn: no second record");
  const counts = emptyLedgerCounts();
  countOutcome(counts, { state: "created", changed: true } as never);
  countOutcome(counts, { state: "conflict", changed: false } as never);
  assert.deepEqual(counts, { ...emptyLedgerCounts(), changed: 1, conflict: 1 });
});

test("withdrawal is appended, never an edit: withdraw, reinstate, each changes the state; the observation stays", async () => {
  const { articleId } = await upsertMaterial(report(url(), { bodyText: "Body.", bodyStatus: "ok" }));
  await sql`INSERT INTO publications (article_id, title, summary, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, visible_after, listed_at)
            VALUES (${articleId}, ${`中文 ${T}`}, '摘要', ${SRC}, 'news', ${url()}, now(), now(), now(), true, now(), now())`;
  await assert.rejects(recordWithdrawal(articleId, { action: "withdraw", basis: "source-retracted", reason: " ", recordedBy: "t" }), WithdrawalInvalid);
  await assert.rejects(recordWithdrawal(articleId, { action: "withdraw", basis: "rumour" as never, reason: "x", recordedBy: "t" }), WithdrawalInvalid);
  await assert.rejects(recordWithdrawal(articleId, { action: "withdraw", basis: "source-retracted", reason: "x", evidenceUrl: "javascript:alert(1)", recordedBy: "t" }), WithdrawalInvalid);
  await assert.rejects(recordWithdrawal(`missing-${T}`, { action: "withdraw", basis: "source-retracted", reason: "x", recordedBy: "t" }), WithdrawalInvalid);
  assert.deepEqual(await recordWithdrawal(articleId, { action: "reinstate", basis: "editorial", reason: "nothing to reinstate", recordedBy: "t" }), { recorded: false, withdrawn: false });
  assert.deepEqual(await recordWithdrawal(articleId, { action: "withdraw", basis: "source-retracted", reason: "retraction notice", evidenceUrl: "https://example.org/retraction", recordedBy: "t" }), { recorded: true, withdrawn: true });
  assert.deepEqual(await recordWithdrawal(articleId, { action: "withdraw", basis: "source-retracted", reason: "again", recordedBy: "t" }), { recorded: false, withdrawn: true });
  const pub = await publishArticle(articleId);
  assert.ok(pub);
  const [p] = await sql<{ eligible: boolean; visibility: string }[]>`SELECT eligible, visibility FROM publications WHERE article_id = ${articleId}`;
  assert.deepEqual({ ...p }, { eligible: false, visibility: "public" }, "out of the pool; its page stays");
  const [a] = await sql<{ title: string }[]>`SELECT title FROM articles WHERE id = ${articleId}`;
  assert.equal(a!.title, `Title ${T}`, "the observation itself is untouched");
  assert.deepEqual(await recordWithdrawal(articleId, { action: "reinstate", basis: "editorial", reason: "the source restored it", recordedBy: "t" }), { recorded: true, withdrawn: false });
  assert.equal((await ledgerStates([articleId])).get(articleId)!.state, "current");
  const h = await articleHistory(articleId);
  assert.deepEqual(h!.withdrawals.map((w) => w.action), ["withdraw", "reinstate"]);
  assert.equal(h!.withdrawals[0]!.evidenceUrl, "https://example.org/retraction");
});

test("the database refuses rewriting the ledger: withdrawals, refused reports, out-of-turn records", async () => {
  const { articleId } = await upsertMaterial(report(url()));
  await recordWithdrawal(articleId, { action: "withdraw", basis: "editorial", reason: "test", recordedBy: "t" });
  const refused = (q: Promise<unknown>) => assert.rejects(q, /observation ledger/);
  await refused(sql`UPDATE article_withdrawals SET reason = 'rewritten' WHERE article_id = ${articleId}`);
  await refused(sql`DELETE FROM article_withdrawals WHERE article_id = ${articleId}`);
  await refused(sql`INSERT INTO article_withdrawals (article_id, action, basis, reason, recorded_by) VALUES (${articleId}, 'withdraw', 'editorial', 'twice', 't')`);
  const { articleId: fresh } = await upsertMaterial(report(url()));
  await refused(sql`INSERT INTO article_withdrawals (article_id, action, basis, reason, recorded_by) VALUES (${fresh}, 'reinstate', 'editorial', 'never withdrawn', 't')`);
  await refused(sql`UPDATE observation_rejections SET title = 'rewritten' WHERE source_id = ${SRC}`);
  await refused(sql`DELETE FROM observation_rejections WHERE source_id = ${SRC}`);
  await assert.rejects(sql`UPDATE article_revisions SET title = 'rewritten' WHERE article_id = ${articleId}`, /article provenance/, "0059 still holds");
  await assert.rejects(sql`UPDATE articles SET title = 'rewritten' WHERE id = ${articleId}`, /article provenance/);
  // Deleting the article (a takedown) takes its records with it.
  await sql`DELETE FROM articles WHERE id = ${articleId}`;
  assert.equal((await sql`SELECT 1 FROM article_withdrawals WHERE article_id = ${articleId}`).length, 0);
});

test("presentation: corrected only for a changed title or a replaced body (a body filled in is no correction)", async () => {
  const { articleId } = await upsertMaterial(report(url()));
  // Extraction fills the body later, as a new revision.
  await recordMaterial(report((await sql<{ url: string }[]>`SELECT url FROM articles WHERE id = ${articleId}`)[0]!.url, { bodyText: "Filled body.", bodyStatus: "ok" }));
  assert.equal((await ledgerStates([articleId])).get(articleId)!.revision, 2);
  assert.equal((await ledgerStates([articleId])).get(articleId)!.state, "current");
  await recordMaterial(report((await sql<{ url: string }[]>`SELECT url FROM articles WHERE id = ${articleId}`)[0]!.url, { bodyText: "Edited body.", bodyStatus: "ok" }));
  assert.equal((await ledgerStates([articleId])).get(articleId)!.state, "corrected");
  assert.equal((await ledgerStates([])).size, 0);
});

test("issues: a withdrawn observation is no candidate; an issue that showed it marks it as retracted material", async () => {
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `ledger ${T}` })).code;
  const reader = await registerWithInvite({ code, email: `ledger-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.70" });
  const proj = await createProject({ ownerId: reader.user.id, target: `账本 ${T}`, purpose: "跟踪进展", sources: [{ sourceId: SRC, required: false }] });
  const u = url();
  const { articleId } = await upsertMaterial(report(u));
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${articleId}`;
  await sql`INSERT INTO publications (article_id, title, summary, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, in_scope, score, visible_after, listed_at)
            VALUES (${articleId}, ${`中文 ${T}`}, '摘要', ${SRC}, 'news', ${u}, now(), now(), now(), true, true, 90, now(), now())`;
  const since = new Date(Date.now() - 3_600_000);
  const until = new Date(Date.now() + 60_000);
  assert.ok((await issueCandidates(reader.user.id, since, until)).some((c) => c.article_id === articleId));
  await sql`INSERT INTO user_issues (user_id, issue_date, issue_no, cutoff, window_since) VALUES (${reader.user.id}, '2026-11-09', 1, now(), now() - interval '1 day')`;
  await sql`INSERT INTO user_issue_items (user_id, issue_date, position, article_id, project_id, listed_at) VALUES (${reader.user.id}, '2026-11-09', 1, ${articleId}, ${proj.project.id}, now())`;
  await recordWithdrawal(articleId, { action: "withdraw", basis: "source-retracted", reason: "retracted", recordedBy: "t" });
  assert.ok(!(await issueCandidates(reader.user.id, since, until)).some((c) => c.article_id === articleId), "no current evidence");
  const issue = await readIssue(reader.user.id, "2026-11-09");
  assert.deepEqual([issue!.items[0]!.id, issue!.items[0]!.ledger, issue!.items[0]!.withdrawal?.reason], [articleId, "retracted-material", "retracted"], "the record stays readable");

  // The history endpoint: the owner reads it; anyone else gets nothing.
  const h = await app.inject({ method: "GET", url: `/api/me/items/${articleId}/history`, headers: { cookie: `${SESSION_COOKIE}=${reader.token}` } });
  assert.equal(h.statusCode, 200, h.body);
  assert.equal(h.json().history.state.state, "retracted-material");
  assert.equal((await app.inject({ method: "GET", url: `/api/me/items/${articleId}/history` })).statusCode, 401);
  const code2 = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `ledger2 ${T}` })).code;
  const stranger = await registerWithInvite({ code: code2, email: `ledger-s-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.71" });
  assert.equal((await app.inject({ method: "GET", url: `/api/me/items/${articleId}/history`, headers: { cookie: `${SESSION_COOKIE}=${stranger.token}` } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/me/items/bad$id/history`, headers: { cookie: `${SESSION_COOKIE}=${reader.token}` } })).statusCode, 404);
});

test("admin: recording a withdrawal (and reinstating) is audited and shown in the content chain", async () => {
  const { articleId } = await upsertMaterial(report(url()));
  const { token } = await passwordLogin(process.env.ADMIN_PASSWORD!, "/admin", "ledger");
  const cookie = `${ADMIN_COOKIE}=${token}`;
  const me = (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })).json() as { csrf: string };
  const post = (payload: unknown, id = articleId) =>
    app.inject({ method: "POST", url: `/api/admin/content/${id}/withdrawal`, headers: { cookie, "x-csrf-token": me.csrf, "content-type": "application/json" }, payload: JSON.stringify(payload) });
  assert.equal((await post({ action: "withdraw", basis: "source-retracted" })).statusCode, 400, "a reason is required");
  assert.equal((await post({ action: "delete", basis: "source-retracted", reason: "x" })).statusCode, 400);
  assert.equal((await post({ action: "withdraw", basis: "nope", reason: "x" })).statusCode, 400);
  assert.equal((await post({ action: "withdraw", basis: "source-retracted", reason: "x" }, `missing-${T}`)).statusCode, 404);
  const ok = await post({ action: "withdraw", basis: "source-retracted", reason: "the publisher retracted it", evidenceUrl: "https://example.org/notice" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().observation.state, "retracted-material");
  assert.equal((await post({ action: "withdraw", basis: "source-retracted", reason: "again" })).statusCode, 409);
  assert.equal((await post({ action: "reinstate", basis: "editorial", reason: "restored" })).statusCode, 200);
  const chain = (await app.inject({ method: "GET", url: `/api/admin/content/${articleId}`, headers: { cookie } })).json();
  assert.deepEqual(chain.withdrawals.map((w: { action: string }) => w.action), ["reinstate", "withdraw"]);
  assert.equal(chain.observation.state, "current");
  const audit = await sql`SELECT action FROM audit_log WHERE subject = ${`content:${articleId}`} ORDER BY id`;
  assert.deepEqual(audit.map((r) => r.action), ["content.withdraw", "content.reinstate"]);
});
