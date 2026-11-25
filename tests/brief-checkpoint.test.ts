// The brief's checkpoint against the database (master design 3.3, 8.1 检查点语义): each server row of
// the result table reached for real (snapshot failed, partial coverage, importance not assessed,
// updates, no change) and refusing or allowing a confirmation as bound; each confirmation rule
// reached through the API; reading, marking, opening, switching language and exporting never move
// the checkpoint; a failed write leaves it in place; a second device's stale snapshot is refused and
// both devices then agree; and the storage guard refuses any move that is not one confirmation forward.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { recordWithdrawal } from "@topka/backend/content/withdrawals";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { loginWithPassword } from "@topka/backend/accounts/login";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";
import { createProject } from "@topka/backend/projects/create-project";
import { buildToday } from "@topka/backend/projects/today";
import { dailyRetention } from "@topka/backend/operations/retention";
import { requireProjectOwner } from "@topka/backend/publication/project-owner";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const S1 = `brief-a-${T}`;
const S2 = `brief-b-${T}`;
const app = await buildApp();
let owner: { token: string; id: string; email: string; password: string };
let project: { id: string; slug: string };
let other: { id: string; slug: string };

const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });
let seq = 0;

async function published(sourceId: string, title: string, minutesAgo = 0) {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.org/brief-${T}/${++seq}`, title: `${title} ${T}`, bodyText: "Body.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  const listed = new Date(Date.now() - minutesAgo * 60_000);
  await sql`
    INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at,
      eligible, selected, score, backfill, visible_after, listed_at)
    VALUES (${articleId}, ${`中文 ${title}`}, ${`${title} ${T}`}, ${`摘要 ${title}`}, ${sourceId}, 'news', ${`https://example.org/brief-${T}/${seq}`}, ${listed}, ${listed}, ${listed},
      true, false, 60, false, ${listed}, ${listed})`;
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${articleId}`;
  return articleId;
}
const today = (token: string, slug = project.slug) => app.inject({ method: "GET", url: `/api/projects/${slug}/today`, headers: cookie(token) });
type View = { snapshot: { id: string | null; ackSeq: number }; items: Array<{ id: string }> };
const ack = (token: string, view: View, body: Record<string, unknown> = {}, slug = project.slug) =>
  app.inject({
    method: "POST", url: `/api/projects/${slug}/today/ack`, headers: { ...cookie(token), "content-type": "application/json" },
    payload: JSON.stringify({ snapshotId: view.snapshot.id, ackSeq: view.snapshot.ackSeq, shownIds: view.items.map((i) => i.id), commandId: `cmd-${T}-${++seq}`, ...body }),
  });
const checkpoint = async () => {
  const [row] = await sql<{ ack_seq: number; read_through: Date | null; snapshot_id: string | null }[]>`
    SELECT ack_seq, read_through, snapshot_id FROM project_read_checkpoints WHERE project_id = ${project.id}`;
  return row ? { ackSeq: Number(row.ack_seq), readThrough: row.read_through?.toISOString() ?? null, snapshotId: row.snapshot_id } : { ackSeq: 0, readThrough: null, snapshotId: null };
};
const setRequired = (sourceId: string, required: unknown, token = owner.token) =>
  app.inject({ method: "PUT", url: `/api/projects/${project.slug}/sources/${sourceId}`, headers: { ...cookie(token), "content-type": "application/json" }, payload: JSON.stringify({ required }) });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at, last_ok_at, health) VALUES
    (${S1}, ${`Brief A ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01', now(), 'ok'),
    (${S2}, ${`Brief B ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01', now() - interval '3 days', 'failing')`;
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `brief ${T}` })).code;
  const email = `brief-${T}@example.com`;
  const password = `${T}-long-enough`;
  const r = await registerWithInvite({ code, email, password, userAgent: "test", ip: "203.0.113.60" });
  owner = { token: r.token, id: r.user.id, email, password };
  const created = await createProject({ ownerId: owner.id, target: `检查点 ${T}`, purpose: "跟踪进展", sources: [{ sourceId: S1, required: true }, { sourceId: S2, required: false }] });
  project = { id: created.project.id, slug: created.project.slug };
  const second = await createProject({ ownerId: owner.id, target: `第二个 ${T}`, purpose: "跟踪进展", sources: [{ sourceId: S1, required: false }] });
  other = { id: second.project.id, slug: second.project.slug };
});
after(async () => {
  await app.close();
  await closeDb();
});

test("updates-available: the snapshot is stored as shown, with its coverage certificate, and may be confirmed", async () => {
  await published(S1, "first");
  const body = (await today(owner.token)).json();
  assert.equal(body.result, "updates-available");
  assert.equal(body.snapshot.acknowledgementAllowed, true);
  assert.equal(body.coverage.satisfied, true, "the one required source was checked just now");
  assert.deepEqual(body.coverage.sources.map((s: { sourceId: string; required: boolean; status: string }) => [s.sourceId, s.required, s.status]),
    [[S1, true, "checked"], [S2, false, "failing"]], "required first; an optional failing source is listed, it does not block");
  const [snap] = await sql`SELECT project_id, top_result, acknowledgement_allowed, item_ids, ack_seq FROM project_brief_snapshots WHERE snapshot_id = ${body.snapshot.id}`;
  assert.deepEqual({ ...snap }, { project_id: project.id, top_result: "updates-available", acknowledgement_allowed: true, item_ids: body.items.map((i: { id: string }) => i.id), ack_seq: 0 });
  const done = await ack(owner.token, body);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal((await checkpoint()).ackSeq, 1);
});

test("no-important-change may be confirmed too: the checkpoint moves to the new window end", async () => {
  const body = (await today(owner.token)).json();
  assert.equal(body.result, "no-important-change");
  assert.equal(body.snapshot.acknowledgementAllowed, true);
  const done = await ack(owner.token, body);
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual([(await checkpoint()).ackSeq, (await checkpoint()).readThrough], [2, body.window.until]);
});

test("partial-coverage: a required source not checked recently blocks confirming; making it optional (owner only) lifts it", async () => {
  await published(S1, "while required is failing");
  assert.equal((await setRequired(S2, true)).statusCode, 200);
  const body = (await today(owner.token)).json();
  assert.equal(body.result, "partial-coverage");
  assert.equal(body.coverage.satisfied, false);
  assert.equal(body.snapshot.acknowledgementAllowed, false);
  assert.equal(body.items.length, 1, "the cards are still shown, read-only");
  const before = await checkpoint();
  const refused = await ack(owner.token, body);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "result_not_acknowledgeable");
  assert.deepEqual(await checkpoint(), before, "a refusal leaves the checkpoint in place");

  assert.equal((await setRequired(S2, "yes")).statusCode, 400);
  assert.equal((await setRequired(`nope-${T}`, false)).statusCode, 404, "an unlinked source");
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `brief stranger ${T}` })).code;
  const stranger = await registerWithInvite({ code, email: `brief-stranger-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.61" });
  assert.equal((await setRequired(S2, false, stranger.token)).statusCode, 404, "a stranger cannot address the project");
  assert.equal((await setRequired(S2, false)).statusCode, 200);
  const lifted = (await today(owner.token)).json();
  assert.equal(lifted.result, "updates-available");
  assert.equal((await ack(owner.token, lifted)).statusCode, 200);
});

test("abstained-impact: material collected in the window but not assessed yet blocks confirming until it is", async () => {
  const { articleId } = await upsertMaterial({ sourceId: S1, url: `https://example.org/brief-${T}/pending`, title: `pending ${T}`, bodyText: "Body.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  // A history import that will never be a card does not count.
  await upsertMaterial({ sourceId: S1, url: `https://example.org/brief-${T}/history`, title: `history ${T}`, via: "import", backfill: "stale-on-discovery", publishedAt: new Date(Date.now() - 30 * 86_400_000) });
  const body = (await today(owner.token)).json();
  assert.equal(body.result, "abstained-impact");
  assert.equal(body.unassessed, 1);
  assert.equal(body.snapshot.acknowledgementAllowed, false);
  assert.equal((await ack(owner.token, body)).json().code, "result_not_acknowledgeable");
  // Assessed (here: judged and skipped): nothing unknown is left.
  await sql`UPDATE articles SET processing_state = 'skipped' WHERE id = ${articleId}`;
  const assessed = (await today(owner.token)).json();
  assert.equal(assessed.result, "no-important-change");
  assert.equal((await ack(owner.token, assessed)).statusCode, 200);
});

test("snapshot-failed: when the snapshot cannot be stored the brief is shown read-only and nothing can be confirmed", async () => {
  await published(S1, "snapshot will fail");
  await sql.unsafe(`CREATE OR REPLACE FUNCTION brief_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: snapshot store down'; END $$`);
  await sql.unsafe(`CREATE TRIGGER brief_test_fail BEFORE INSERT ON project_brief_snapshots FOR EACH ROW EXECUTE FUNCTION brief_test_fail()`);
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    const body = (await today(owner.token)).json();
    assert.equal(body.result, "snapshot-failed");
    assert.equal(body.snapshot.id, null);
    assert.equal(body.snapshot.acknowledgementAllowed, false);
    assert.equal(body.items.length, 1);
    assert.equal((await ack(owner.token, body)).statusCode, 400, "no snapshot, nothing to confirm");
    assert.equal(errors.length, 1, "the failure is logged");
  } finally {
    console.error = log;
    await sql.unsafe(`DROP TRIGGER brief_test_fail ON project_brief_snapshots`);
    await sql.unsafe(`DROP FUNCTION brief_test_fail()`);
  }
});

test("every confirmation rule through the API: project, revision, ackSeq, cards shown, commandId; unknown snapshots are not found", async () => {
  const body = (await today(owner.token)).json();
  assert.equal(body.result, "updates-available");
  const theirs = (await today(owner.token, other.slug)).json();
  assert.equal((await ack(owner.token, theirs)).json().code, "project_mismatch", "another project's snapshot");
  assert.equal((await ack(owner.token, body, { ackSeq: body.snapshot.ackSeq + 1 })).json().code, "ack_seq_mismatch");
  assert.equal((await ack(owner.token, body, { shownIds: [] })).json().code, "titles_not_shown");
  assert.equal((await ack(owner.token, body, { commandId: "" })).json().code, "command_required");
  assert.equal((await ack(owner.token, body, { snapshotId: "brief-snapshot-v1:" + "0".repeat(32) })).statusCode, 404);

  await sql`UPDATE tracking_projects SET current_revision = current_revision + 1 WHERE id = ${project.id}`;
  assert.equal((await ack(owner.token, body)).json().code, "revision_mismatch", "the project was revised since the snapshot");
  const revised = (await today(owner.token)).json();
  const cmd = `same-${T}`;
  const first = await ack(owner.token, revised, { commandId: cmd });
  assert.equal(first.statusCode, 200, first.body);
  const replay = await ack(owner.token, revised, { commandId: cmd });
  assert.deepEqual([replay.json().checkpoint.idempotent, replay.json().checkpoint.receiptId], [true, first.json().checkpoint.receiptId], "the same command: the same receipt");
  await published(S1, "after the revision");
  const later = (await today(owner.token)).json();
  assert.equal((await ack(owner.token, later, { commandId: cmd })).json().code, "command_required", "a used commandId cannot confirm another snapshot");
  assert.equal((await ack(owner.token, later)).statusCode, 200);
});

test("reading, marking, opening, switching language and exporting never move the checkpoint", async () => {
  const id = await published(S1, "read but not confirmed");
  const before = await checkpoint();
  await today(owner.token);
  const h = { ...cookie(owner.token), "content-type": "application/json" };
  assert.equal((await app.inject({ method: "POST", url: "/api/me/today/mark", headers: h, payload: JSON.stringify({ articleId: id, mark: "seen" }) })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/me/today/mark", headers: h, payload: JSON.stringify({ articleId: id, mark: "later" }) })).statusCode, 200);
  await app.inject({ method: "POST", url: "/api/me/issues/read", headers: h, payload: JSON.stringify({ articleId: id }) });
  assert.equal((await app.inject({ method: "PATCH", url: "/api/auth/me", headers: h, payload: JSON.stringify({ locale: "en" }) })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/auth/me", headers: h, payload: JSON.stringify({ locale: "zh-CN" }) })).statusCode, 200);
  const access = await requireProjectOwner(owner.id, project.id);
  assert.equal(access.kind, "ok");
  if (access.kind === "ok") await buildToday(access.project, owner.id, { record: true });
  assert.deepEqual(await checkpoint(), before);
  assert.equal((await today(owner.token)).json().items.length, 1, "the card is still there");
});

test("a write that fails half-way leaves the checkpoint where it was", async () => {
  const body = (await today(owner.token)).json();
  const before = await checkpoint();
  await sql.unsafe(`CREATE OR REPLACE FUNCTION brief_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: log down'; END $$`);
  await sql.unsafe(`CREATE TRIGGER brief_test_fail BEFORE INSERT ON project_checkpoint_acks FOR EACH ROW EXECUTE FUNCTION brief_test_fail()`);
  try {
    const failed = await ack(owner.token, body);
    assert.ok(failed.statusCode >= 500, `${failed.statusCode}`);
  } finally {
    await sql.unsafe(`DROP TRIGGER brief_test_fail ON project_checkpoint_acks`);
    await sql.unsafe(`DROP FUNCTION brief_test_fail()`);
  }
  assert.deepEqual(await checkpoint(), before, "the checkpoint update was rolled back with the log");
  assert.equal((await ack(owner.token, body)).statusCode, 200, "the same snapshot confirms once the store is back");
});

test("across devices: a snapshot built before the other device confirmed is refused; both then show the same position", async () => {
  await published(S1, "two devices");
  const second = await loginWithPassword({ email: owner.email, password: owner.password, userAgent: "phone", ip: "203.0.113.62" });
  const laptop = (await today(owner.token)).json();
  const phone = (await today(second.token)).json();
  assert.equal((await ack(second.token, phone)).statusCode, 200, "the phone confirms first");
  const late = await ack(owner.token, laptop);
  assert.equal(late.json().code, "ack_seq_mismatch", "the laptop's snapshot was built on the old sequence");
  const a = (await today(owner.token)).json().checkpoint;
  const b = (await today(second.token)).json().checkpoint;
  assert.deepEqual(a, b);
  assert.equal(a.readThrough, phone.window.until);
});

test("a withdrawn observation never becomes a card", async () => {
  const id = await published(S1, "to be withdrawn");
  assert.ok((await today(owner.token)).json().items.some((i: { id: string }) => i.id === id));
  await recordWithdrawal(id, { action: "withdraw", basis: "source-retracted", reason: "publisher retracted it", recordedBy: "test" });
  assert.ok(!(await today(owner.token)).json().items.some((i: { id: string }) => i.id === id));
});

test("an old checkpoint looks back at most 7 days", async () => {
  const access = await requireProjectOwner(owner.id, project.id);
  assert.equal(access.kind, "ok");
  if (access.kind !== "ok") return;
  const later = await buildToday(access.project, owner.id, { now: new Date(Date.now() + 30 * 86_400_000) });
  assert.equal(later.window.basis, "capped");
});

test("the storage guard: a checkpoint moves only one confirmation forward, to a confirmable snapshot; history is never rewritten", async () => {
  const fails = (q: Promise<unknown>) => assert.rejects(q, /brief checkpoint|integrity/);
  const cp = await checkpoint();
  await fails(sql`UPDATE project_read_checkpoints SET read_through = read_through - interval '1 hour' WHERE project_id = ${project.id}`);
  await fails(sql`UPDATE project_read_checkpoints SET ack_seq = ack_seq + 2, read_through = now() WHERE project_id = ${project.id}`);
  await fails(sql`UPDATE project_read_checkpoints SET ack_seq = ack_seq + 1, read_through = now(), snapshot_id = 'brief-snapshot-v1:${sql.unsafe("0".repeat(32))}' WHERE project_id = ${project.id}`);
  await fails(sql`UPDATE project_read_checkpoints SET ack_seq = ack_seq - 1 WHERE project_id = ${project.id}`);
  await fails(sql`UPDATE project_read_checkpoints SET snapshot_id = NULL WHERE project_id = ${project.id}`);
  await fails(sql`INSERT INTO project_read_checkpoints (user_id, project_id, ack_seq, read_through) VALUES (${owner.id}, ${other.id}, 5, now())`);
  await fails(sql`UPDATE project_brief_snapshots SET top_result = 'updates-available', acknowledgement_allowed = true WHERE project_id = ${project.id}`);
  await fails(sql`DELETE FROM project_brief_snapshots WHERE project_id = ${project.id}`);
  await fails(sql`UPDATE project_checkpoint_acks SET receipt_id = 'receipt-00000000' WHERE project_id = ${project.id}`);
  await fails(sql`DELETE FROM project_checkpoint_acks WHERE project_id = ${project.id}`);
  await assert.rejects(sql`INSERT INTO project_brief_snapshots (snapshot_id, user_id, project_id, revision, ack_seq, window_since, window_until, basis, coverage, item_ids, unassessed, top_result, acknowledgement_allowed)
    VALUES (${"brief-snapshot-v1:" + "1".repeat(32)}, ${owner.id}, ${project.id}, 1, 0, now(), now(), 'default', '[]', '{}', 0, 'partial-coverage', true)`, /check/i, "the permission is bound to the result");
  assert.deepEqual(await checkpoint(), cp);
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM project_checkpoint_acks WHERE project_id = ${project.id}`;
  assert.equal(n, cp.ackSeq, "one log row per confirmation");
  // Deleting the project takes its history with it.
  const doomed = await createProject({ ownerId: owner.id, target: `删除 ${T}`, purpose: "跟踪进展", sources: [{ sourceId: S1, required: false }] });
  const d = await requireProjectOwner(owner.id, doomed.project.id);
  if (d.kind === "ok") await buildToday(d.project, owner.id);
  await sql`DELETE FROM tracking_projects WHERE id = ${doomed.project.id}`;
  const [{ left }] = await sql<{ left: number }[]>`SELECT count(*)::int AS left FROM project_brief_snapshots WHERE project_id = ${doomed.project.id}`;
  assert.equal(left, 0);
});

test("retention drops only unreferenced snapshots older than 30 days and article-less refusals older than 180", async () => {
  const id = (n: string) => `brief-snapshot-v1:${n.padStart(32, "0")}`;
  const row = (snapshotId: string, daysAgo: number) => sql`INSERT INTO project_brief_snapshots
      (snapshot_id, user_id, project_id, revision, ack_seq, window_since, window_until, basis, coverage, item_ids, unassessed, top_result, acknowledgement_allowed, created_at)
    VALUES (${snapshotId}, ${owner.id}, ${project.id}, 1, 999, now(), now(), 'test', '[]'::jsonb, '{}', 0, 'no-important-change', true, now() - make_interval(days => ${daysAgo}))`;
  await row(id("a1"), 31);
  await row(id("a2"), 5);
  await sql`INSERT INTO observation_rejections (state, code, url, title, reported_at) VALUES
    ('failed', 'missing-provenance', ${`old-${T}`}, 'old', now() - interval '181 days'),
    ('failed', 'missing-provenance', ${`new-${T}`}, 'new', now() - interval '10 days')`;
  const out = await dailyRetention();
  assert.ok(out.deletedBriefSnapshots >= 1 && out.deletedRejections >= 1, JSON.stringify(out));
  const left = await sql<{ snapshot_id: string }[]>`SELECT snapshot_id FROM project_brief_snapshots WHERE snapshot_id IN (${id("a1")}, ${id("a2")})`;
  assert.deepEqual(left.map((r) => r.snapshot_id), [id("a2")]);
  // A referenced snapshot survives however old: the confirmed one the checkpoint points at.
  const [cp] = await sql<{ snapshot_id: string | null }[]>`SELECT snapshot_id FROM project_read_checkpoints WHERE user_id = ${owner.id} AND project_id = ${project.id}`;
  if (cp?.snapshot_id) assert.equal((await sql`SELECT 1 FROM project_brief_snapshots WHERE snapshot_id = ${cp.snapshot_id}`).length, 1);
  const kept = await sql<{ url: string }[]>`SELECT url FROM observation_rejections WHERE url IN (${`old-${T}`}, ${`new-${T}`})`;
  assert.deepEqual(kept.map((r) => r.url), [`new-${T}`]);
});
