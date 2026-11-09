// The per-project today view: a fixed number of cards (TODAY_CARD_COUNT) from the published, pool-eligible
// items of the project's active linked sources that entered since the reader's checkpoint, ordered by the
// project score, one card per event, with a quiet-day flag; an explicit
// "无重要变化" when nothing qualifies; a server-side checkpoint that only an acknowledgement moves,
// only forward; owner-only access by id or slug; derived ids that always fit a route segment; and
// the snapshot export, which never moves a checkpoint.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";
import { createProject } from "@topka/backend/projects/create-project";
import { deriveProjectId, MAX_PROJECT_ID_LENGTH, projectSlug } from "@topka/backend/projects/derive-id";
import { NO_CHANGE_TITLE } from "@topka/backend/projects/today";
import { buildApp } from "../apps/api/src/app.ts";

const run = promisify(execFile);
const T = tag();
const A = `today-a-${T}`; // linked, enabled
const B = `today-b-${T}`; // linked, switched off
const C = `today-c-${T}`; // not linked
const app = await buildApp();
let owner: { token: string; id: string };
let stranger: { token: string; id: string };
let project: { id: string; slug: string };

async function user(n: string) {
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `today ${T}` })).code;
  const r = await registerWithInvite({ code, email: `${n}-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.50" });
  return { token: r.token, id: r.user.id };
}
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

let seq = 0;
/** A published item: listed `minutesAgo` minutes ago, eligible unless said otherwise. */
async function published(sourceId: string, title: string, opts: { minutesAgo?: number; eligible?: boolean; selected?: boolean; score?: number; backfill?: boolean; backfillReason?: string; publishedMinutesAgo?: number; visibleInMinutes?: number } = {}) {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.org/today-${T}/${++seq}`, title: `${title} ${T}`, bodyText: "Body.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  const listed = new Date(Date.now() - (opts.minutesAgo ?? 5) * 60_000);
  const visible = opts.visibleInMinutes === undefined ? listed : new Date(Date.now() + opts.visibleInMinutes * 60_000);
  const publishedAt = opts.publishedMinutesAgo === undefined ? listed : new Date(Date.now() - opts.publishedMinutesAgo * 60_000);
  await sql`
    INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at,
      eligible, selected, score, backfill, visible_after, listed_at)
    VALUES (${articleId}, ${`中文 ${title}`}, ${`${title} ${T}`}, ${`摘要 ${title}`}, ${sourceId}, 'news', ${`https://example.org/today-${T}/${seq}`}, ${publishedAt}, ${listed}, ${listed}, ${listed},
      ${opts.eligible ?? true}, ${opts.selected ?? false}, ${opts.score ?? null}, ${opts.backfill ?? false}, ${visible}, ${listed})`;
  await sql`UPDATE articles SET processing_state = 'analyzed', backfill = ${opts.backfill ?? false}, backfill_reason = ${opts.backfillReason ?? null} WHERE id = ${articleId}`;
  return articleId;
}
const today = (token: string, id = project.slug) => app.inject({ method: "GET", url: `/api/projects/${id}/today`, headers: cookie(token) });
const ack = (token: string, through: string, id = project.slug) =>
  app.inject({ method: "POST", url: `/api/projects/${id}/today/ack`, headers: { ...cookie(token), "content-type": "application/json" }, payload: JSON.stringify({ through }) });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES
    (${A}, ${`Today A ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01'),
    (${B}, ${`Today B ${T}`}, 'rss', 'T1', 'editorial', false, '2100-01-01'),
    (${C}, ${`Today C ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  owner = await user("owner");
  stranger = await user("stranger");
  const created = await createProject({ ownerId: owner.id, target: `具身智能 ${T}`, purpose: "跟踪进展", sources: [{ sourceId: A, required: false }, { sourceId: B, required: false }] });
  project = { id: created.project.id, slug: created.project.slug };
});
after(async () => {
  await app.close();
  await closeDb();
});

test("nothing qualifying is the explicit 无重要变化 result, not an error", async () => {
  await published(A, "ineligible", { eligible: false });
  await published(A, "history", { backfill: true });
  await published(A, "yesterday", { minutesAgo: 25 * 60 });
  await published(B, "switched off source");
  await published(C, "unlinked source");
  await published(A, "not released yet", { selected: true, visibleInMinutes: 30 });
  const res = await today(owner.token);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.result, "no-important-change");
  assert.deepEqual(body.items, []);
  assert.equal(body.candidates, 0);
  assert.equal(body.cardCount, 3);
  assert.equal(body.quietDay, true);
  assert.equal(body.cardsMean, null);
  assert.equal(body.emptyState.title, NO_CHANGE_TITLE);
  assert.equal(body.emptyState.title, "无重要变化");
  assert.equal(body.window.basis, "default", "without a checkpoint, today is the last 24 hours");
  assert.equal(body.checkpoint.readThrough, null);
  assert.deepEqual(body.sources, { linked: 2, active: 1 });
  assert.equal(body.project.slug, project.slug);
  assert.equal(body.kind, "project-today");
  assert.equal(body.schemaVersion, 2);
  assert.equal("overflow" in body, false, "no overflow list");
});

test("published items of the active linked sources come by score, with original link and source", async () => {
  await published(A, "plain newer", { minutesAgo: 2 });
  await published(A, "scored", { minutesAgo: 10, score: 80 });
  await published(A, "picked", { minutesAgo: 20, selected: true, score: 60 });
  const body = (await today(owner.token)).json();
  assert.equal(body.result, "updates-available");
  assert.equal(body.emptyState, null);
  assert.deepEqual(body.items.map((i: { originalTitle: string }) => i.originalTitle.replace(` ${T}`, "")), ["scored", "picked", "plain newer"]);
  const first = body.items[1];
  assert.equal(first.title, "中文 picked");
  assert.equal(first.summary, "摘要 picked");
  assert.match(first.url, /^https:\/\/example\.org\/today-/);
  assert.deepEqual(first.source, { id: A, name: `Today A ${T}` });
  assert.equal(first.selected, true);
  assert.deepEqual([first.score, first.scoreBasis, first.genericScore], [60, "generic", 60], "no project score yet: the generic one");
  assert.ok(first.listedAt && first.publishedAt);
  assert.equal(body.candidates, 3);
  assert.equal(body.cardsMean, 70, "over the scored cards");
  assert.equal(body.quietDay, false);
});

test("the checkpoint: reading never moves it; an acknowledgement moves it forward only; new items show again", async () => {
  const seen = (await today(owner.token)).json();
  assert.equal((await today(owner.token)).json().items.length, 3, "reading twice does not consume anything");
  const done = await ack(owner.token, seen.window.until);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().checkpoint.advanced, true);
  const after = (await today(owner.token)).json();
  assert.equal(after.result, "no-important-change", "everything up to the confirmed instant is read");
  assert.equal(after.window.basis, "checkpoint");
  assert.equal(after.checkpoint.readThrough, seen.window.until);

  const older = await ack(owner.token, new Date(Date.parse(seen.window.until) - 3_600_000).toISOString());
  assert.equal(older.statusCode, 200);
  assert.equal(older.json().checkpoint.advanced, false);
  assert.equal(older.json().checkpoint.readThrough, seen.window.until, "an older acknowledgement never moves it back");
  assert.equal((await ack(owner.token, seen.window.until)).json().checkpoint.advanced, false, "the same acknowledgement is idempotent");
  assert.equal((await ack(owner.token, new Date(Date.now() + 3_600_000).toISOString())).statusCode, 400, "a checkpoint in the future is refused");
  assert.equal((await ack(owner.token, "not a time")).statusCode, 400);

  await published(A, "after the read", { minutesAgo: 0 });
  const next = (await today(owner.token)).json();
  assert.equal(next.result, "updates-available");
  assert.deepEqual(next.items.map((i: { originalTitle: string }) => i.originalTitle.replace(` ${T}`, "")), ["after the read"]);

  // An old checkpoint looks back at most 7 days.
  await sql`UPDATE project_read_checkpoints SET read_through = now() - interval '30 days' WHERE project_id = ${project.id}`;
  assert.equal((await today(owner.token)).json().window.basis, "capped");
});

test("only the owner reads or acknowledges; id and slug both address the project, no double encoding needed", async () => {
  assert.equal((await today(stranger.token)).statusCode, 404);
  assert.equal((await ack(stranger.token, new Date().toISOString())).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/projects/${project.slug}/today` })).statusCode, 404, "anonymous reads as not-found");
  assert.equal((await today(owner.token, encodeURIComponent(project.id))).statusCode, 200, "the derived id, encoded once");
  assert.equal((await today(owner.token, project.id)).statusCode, 200, "the derived id as stored, percent escapes and all");
  assert.equal((await today(owner.token, "pffffffffffff")).statusCode, 404);
  const list = await app.inject({ method: "GET", url: "/api/projects", headers: cookie(owner.token) });
  assert.equal(list.json().projects[0].slug, project.slug);
});

test("derived ids always fit a route segment; slugs are short, stable and match the migration", async () => {
  const long = "跟踪具身智能：VLA、人形机器人、机器人基础模型、仿真与开源框架的一手进展";
  const id = deriveProjectId("具身智能", long, owner.id);
  assert.ok(id.length <= MAX_PROJECT_ID_LENGTH, `${id.length}`);
  assert.match(id, /^project:h[0-9a-f]{32}:[0-9a-f]{8}$/);
  assert.equal(deriveProjectId("具身智能", long, owner.id), id, "stable");
  assert.notEqual(deriveProjectId("具身智能", long, stranger.id), id, "per user");
  assert.ok(deriveProjectId("具身智能", "跟踪进展", owner.id).startsWith("project:%E5"), "a short goal keeps the readable form");

  const created = await app.inject({ method: "POST", url: "/api/projects", headers: { ...cookie(owner.token), "content-type": "application/json" }, payload: JSON.stringify({ target: "具身智能", purpose: long, sourceIds: [A] }) });
  assert.equal(created.statusCode, 201, created.body);
  const { id: longId, slug } = created.json().project;
  assert.equal(longId, id);
  assert.match(slug, /^p[0-9a-f]{12}$/);
  assert.equal(slug, projectSlug(longId));
  assert.equal((await app.inject({ method: "GET", url: `/api/projects/${longId}`, headers: cookie(owner.token) })).statusCode, 200);
  const [row] = await sql<{ s: string }[]>`SELECT 'p' || left(encode(sha256(convert_to(${project.id}, 'UTF8')), 'hex'), 12) AS s`;
  assert.equal(row!.s, project.slug, "the migration's backfill formula is the one the code uses");
});

test("the snapshot export writes the owner's payload per slug and never moves a checkpoint", async () => {
  const before = (await sql`SELECT read_through FROM project_read_checkpoints WHERE project_id = ${project.id}`)[0]!.read_through;
  const out = mkdtempSync(join(tmpdir(), "today-"));
  const { stdout } = await run(process.execPath, ["scripts/export-today.ts", "--project", project.slug, "--out", out]);
  assert.match(stdout, new RegExp(`${project.slug}\\.json`));
  const snap = JSON.parse(readFileSync(join(out, `${project.slug}.json`), "utf8"));
  assert.equal(snap.kind, "project-today");
  assert.equal(snap.project.id, project.id);
  assert.ok(["updates-available", "no-important-change"].includes(snap.result));
  const afterExport = (await sql`SELECT read_through FROM project_read_checkpoints WHERE project_id = ${project.id}`)[0]!.read_through;
  assert.equal(new Date(afterExport).toISOString(), new Date(before).toISOString());
  await assert.rejects(run(process.execPath, ["scripts/export-today.ts", "--project", "pnosuchproject", "--out", out]), (e: { code?: number }) => e.code === 1);
});

test("a source's first import counts only for items it published in the last 24 hours", async () => {
  const D = `today-d-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES (${D}, ${`Today D ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  const created = await createProject({ ownerId: owner.id, target: `首次导入 ${T}`, purpose: "跟踪进展", sources: [{ sourceId: D, required: false }] });
  const slug = created.project.slug;
  await published(D, "fresh import", { backfill: true, backfillReason: "first-import", publishedMinutesAgo: 120 });
  await published(D, "old import", { backfill: true, backfillReason: "first-import", publishedMinutesAgo: 3 * 24 * 60 });
  await published(D, "stale on discovery", { backfill: true, backfillReason: "stale-on-discovery", publishedMinutesAgo: 60 });
  await published(D, "history without reason", { backfill: true, publishedMinutesAgo: 60 });
  await published(D, "live item");
  const res = await today(owner.token, slug);
  assert.equal(res.statusCode, 200, res.body);
  const titles = (res.json().items as Array<{ title: string }>).map((i) => i.title).sort();
  assert.deepEqual(titles, ["中文 fresh import", "中文 live item"]);
});

test("a fixed number of cards by project score, one per event; the rest is not listed; quiet when the cards average below 50", async () => {
  const E = `today-e-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES (${E}, ${`Today E ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  const created = await createProject({ ownerId: owner.id, target: `卡片 ${T}`, purpose: "跟踪进展", sources: [{ sourceId: E, required: false }] });
  const pid = created.project.id;
  const slug = created.project.slug;
  const scoreFor = (articleId: string, score: number) =>
    sql`INSERT INTO project_scores (project_id, article_id, source_id, input_revision, project_revision, scores, score, prompt_version)
        VALUES (${pid}, ${articleId}, ${E}, 1, 1, ${[score, score]}, ${score}, 'test')`;
  // The generic score says big AI news; the project says off-goal.
  const offGoal = await published(E, "big off-goal news", { score: 95 });
  await scoreFor(offGoal, 12);
  const story = (await sql<{ id: string }[]>`INSERT INTO stories (public_id, title) VALUES (gen_random_uuid(), ${`事件 ${T}`}) RETURNING id`)[0]!.id;
  for (const [title, score] of [["event report one", 88], ["event report two", 90]] as const) {
    const id = await published(E, title);
    await scoreFor(id, score);
    await sql`UPDATE publications SET story_id = ${story} WHERE article_id = ${id}`;
  }
  for (const [title, score] of [["on-goal a", 70], ["on-goal b", 60], ["on-goal c", 55]] as const) await scoreFor(await published(E, title), score);

  const body = (await today(owner.token, slug)).json();
  const titles = body.items.map((i: { originalTitle: string }) => i.originalTitle.replace(` ${T}`, ""));
  assert.deepEqual(titles, ["event report two", "on-goal a", "on-goal b"], "default 3 cards; the event takes one slot; off-goal sinks");
  assert.deepEqual([body.cardCount, body.candidates, body.quietDay, body.cardsMean], [3, 5, false, 73.3]);
  assert.equal(body.items[0].scoreBasis, "project");
  assert.equal(body.items[0].storyId, String(story));
  const shown = await sql<{ article_id: string }[]>`SELECT article_id FROM project_today_shown WHERE project_id = ${pid}`;
  assert.equal(shown.length, 3, "the API records the cards it showed (monthly source report)");

  process.env.TODAY_CARD_COUNT = "5";
  try {
    const five = (await today(owner.token, slug)).json();
    assert.equal(five.items.length, 5, "always filled when enough candidates exist, no floor");
    assert.equal(five.items[4].originalTitle.replace(` ${T}`, ""), "big off-goal news");
    assert.equal(five.quietDay, false);
  } finally {
    delete process.env.TODAY_CARD_COUNT;
  }
  const { todayCardCount } = await import("@topka/backend/projects/today");
  assert.deepEqual([todayCardCount("3"), todayCardCount("4"), todayCardCount("5"), todayCardCount("9"), todayCardCount("2"), todayCardCount(undefined), todayCardCount("x")], [3, 4, 5, 3, 3, 3, 3]);

  await sql`UPDATE project_scores SET score = 20 WHERE project_id = ${pid}`;
  const quiet = (await today(owner.token, slug)).json();
  assert.equal(quiet.items.length, 3, "a weak day still shows its cards");
  assert.equal(quiet.quietDay, true);
  const [month] = await sql<{ scored: number; shown: number }[]>`SELECT scored, shown FROM project_source_score_monthly WHERE project_id = ${pid} AND source_id = ${E}`;
  assert.deepEqual([month!.scored, month!.shown], [6, 5], "the 5-card read showed two more");
});

test("a report an unlinked source stored first counts when a linked source listed it too", async () => {
  const reader = await user("discover");
  const own = await createProject({ ownerId: reader.id, target: `发现 ${T}`, purpose: "跟踪进展", sources: [{ sourceId: A, required: false }] });
  const id = await published(C, "found elsewhere first", { minutesAgo: 1, score: 99 });
  const url = `https://example.org/today-${T}/${seq}`;
  const titleOf = (b: { items: Array<{ id: string }> }) => b.items.map((i) => i.id);
  assert.ok(!titleOf((await today(reader.token, own.project.slug)).json()).includes(id), "not yet listed by a linked source");
  await upsertMaterial({ sourceId: A, url, title: `found elsewhere first ${T}`, bodyText: "Body.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  const body = (await today(reader.token, own.project.slug)).json();
  assert.equal(body.items[0].id, id);
  assert.equal(body.items[0].source.id, C, "the card names the source that stored it");
});
