// The daily issue (v4.4): fixed every day at 08:00 Taipei (00:00 UTC), up to 3 items from the window
// since the previous issue's cutoff, the chosen articles and their whole events never come back, an
// empty day keeps its row (issue_no NULL, not counted), and the issue numbers never skip. Card copy is
// separate (issue_card_copy): until written the item falls back to the publication's own title and
// summary. Only the signed-in user sees their own snapshot, archive and read state.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";
import { createProject } from "@topka/backend/projects/create-project";
import { MAX_PER_SOURCE } from "@topka/backend/projects/issue-rules";
import { AI_NOTICE, buildUserIssue, ensureIssue, ISSUE_MIN_SCORE, issueItemsWithoutCopy, isIssueDate, issueCount, listArchive, listPastIssues, readIssue, recordOpened } from "@topka/backend/projects/issues";
import { buildApp } from "../apps/api/src/app.ts";

assert.equal(process.env.ISSUE_HERO_LEAD, undefined, "the hero tests need the default lead (ISSUE_HERO_LEAD unset)");

const T = tag();
const app = await buildApp();
after(async () => {
  await app.close();
  await closeDb();
});

// The moments the scenarios use: 15:00 Taipei of day 1 (issue 1's fix point) and 08:05 Taipei (00:05
// UTC) of day 2, shortly after this day's fix. The UTC day switches at 00:00 between them.
const N1 = new Date("2026-10-22T07:00:00Z");
const N2 = new Date("2026-10-23T00:05:00Z");
const DAY1 = "2026-10-22";
const DAY2 = "2026-10-23";
const DAY3 = "2026-10-24";

let seq = 0;
async function reader(name: string, ip: string) {
  const code = (await createInvite({ createdBy: `t-${T}`, maxUses: 1, expiresInDays: 7, note: `is-${name}` })).code;
  const r = await registerWithInvite({ code, email: `is-${name}-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip });
  const source = `is-${name}-${T}`;
  // Three linked sources under one name: item(u.source, …) spreads over them so the per-source cap
  // (MAX_PER_SOURCE) stays out of the scenarios that are not about it; itemFrom pins one.
  const all = [source, `${source}-b`, `${source}-c`];
  for (const id of all) await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES (${id}, ${`UT issue ${name} ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  const project = (await createProject({ ownerId: r.user.id, target: `发布 ${name} ${T}`, purpose: "跟踪", sources: all.map((sourceId) => ({ sourceId, required: false })) })).project.id;
  return { userId: r.user.id, token: r.token, project, source, all, name };
}

/** A publication listed at `listed` (entered_at = listed), scored by the project when `score` is a number. */
async function item(source: string, project: string, score: number | null, listed: Date, title: string) {
  return itemFrom([source, `${source}-b`, `${source}-c`][seq % 3]!, project, score, listed, title);
}

async function itemFrom(sourceId: string, project: string, score: number | null, listed: Date, title: string) {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.org/is-${T}/${++seq}`, title: `en ${title} ${T}`, bodyText: "Body.", bodyStatus: "ok", via: "fetch", publishedAt: listed });
  await sql`
    INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, score, visible_after, listed_at)
    VALUES (${articleId}, ${`中文：${title} ${T}`}, null, ${`摘要：${title} ${T}`}, ${sourceId}, 'news', ${`https://example.org/is-${T}/${seq}`}, ${listed}, ${listed}, ${listed}, ${listed}, true, ${score}, ${listed}, ${listed})`;
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${articleId}`;
  if (score !== null) {
    await sql`INSERT INTO project_scores (project_id, article_id, source_id, input_revision, project_revision, scores, score, prompt_version)
              VALUES (${project}, ${articleId}, ${sourceId}, 1, 1, ${[score, score]}, ${score}, 'test')`;
  }
  return articleId;
}

const pubTitle = async (articleId: string) => (await sql<{ title: string }[]>`SELECT title FROM publications WHERE article_id = ${articleId}`)[0]!.title;

const issueTitlesOf = async (day: string, userId: string) =>
  (await sql<{ position: number; title: string; article_id: string }[]>`
    SELECT ui.position, p.title, ui.article_id FROM user_issue_items ui JOIN publications p ON p.article_id = ui.article_id
    WHERE ui.user_id = ${userId} AND ui.issue_date = ${day} ORDER BY ui.position`);

before(async () => {
  delete process.env.ISSUE_HERO_LEAD;
});

test("the first issue: the top 3 of the last 24h at its fix point, with the fallback items", async () => {
  const u = await reader("first", "203.0.113.70");
  const scores = [88, 80, 70, 60];
  for (const [i, score] of scores.entries()) await item(u.source, u.project, score, new Date(N1.getTime() - (i + 1) * 15 * 60_000), `day1 #${i + 1}`);
  assert.deepEqual(await ensureIssue(u.userId, { now: N1 }), { date: DAY1, created: true });
  const rows = await issueTitlesOf(DAY1, u.userId);
  assert.deepEqual(rows.map((r) => r.title), [`中文：day1 #1 ${T}`, `中文：day1 #2 ${T}`, `中文：day1 #3 ${T}`], "the top 3 by score");
  const [head] = await sql<{ issue_no: number; cutoff: Date }[]>`SELECT issue_no, cutoff FROM user_issues WHERE user_id = ${u.userId} AND issue_date = ${DAY1}`;
  assert.deepEqual([head!.issue_no, head!.cutoff.toISOString()], [1, N1.toISOString()]);

  const b = await buildUserIssue(u.userId, { now: N1 });
  assert.deepEqual([b.schemaVersion, b.kind, b.user.id], [3, "user-issue", u.userId]);
  assert.ok(b.projects.some((p) => p.id === u.project));
  const issue = b.issue!;
  assert.deepEqual([issue.date, issue.no, issue.hero, issue.ready], [DAY1, 1, false, false]);
  assert.deepEqual(issue.items.map((i) => [i.position, i.score, i.hasCopy, i.overBudget]), [[1, 88, false, false], [2, 80, false, false], [3, 70, false, false]]);
  for (const it of issue.items) {
    assert.equal(it.title_a, `中文：day1 #${it.position} ${T}`, "title_a falls back to the publication title");
    assert.deepEqual([it.title_b, it.core_a, it.core_b, it.tag], ["", "", "", ""]);
    assert.equal(it.summary, `摘要：day1 #${it.position} ${T}`, "the summary falls back to the publication summary");
    assert.equal(it.source, `UT issue first ${T}`);
    assert.equal(it.project.id, u.project);
    assert.ok(it.listedAt.startsWith(DAY1));
  }
  assert.equal(new Date(b.generatedAt).getTime(), N1.getTime());
  assert.equal(b.nextAt, "2026-10-23T00:00:00.000Z");
  assert.deepEqual(b.opened, []);
  assert.deepEqual(b.archive, []);
  assert.equal(b.issueCount, 1);
  assert.equal(b.notice, AI_NOTICE);

  assert.deepEqual((await listArchive(u.userId, sql, { exclude: DAY1 })).length, 0, "the displayed day is excluded");
  assert.equal(await issueCount(u.userId), 1);
  assert.deepEqual((await issueItemsWithoutCopy(u.userId, DAY1)).map((r) => r.position), [1, 2, 3]);
});

test("a fixed issue does not move: a later, better article waits for the next day", async () => {
  const u = await reader("fixed", "203.0.113.71");
  for (const [i, score] of [90, 80, 70, 60].entries()) await item(u.source, u.project, score, new Date(N1.getTime() - (i + 1) * 15 * 60_000), `fixed #${i + 1}`);
  assert.deepEqual(await ensureIssue(u.userId, { now: N1 }), { date: DAY1, created: true });
  const before = await readIssue(u.userId, DAY1);
  assert.deepEqual(await ensureIssue(u.userId, { now: new Date(N1.getTime() + 3_600_000) }), { date: DAY1, created: false });
  const late = await item(u.source, u.project, 99, new Date(N1.getTime() + 30 * 60_000), "late better");
  const after = await readIssue(u.userId, DAY1);
  assert.deepEqual(after!.items.map((i) => i.id), before!.items.map((i) => i.id), "the same three items");
  assert.ok(!after!.items.some((i) => i.id === late), "the later, better article waits");
});

test("the next day: the previous cutoff bounds the window, entries outside stay out", async () => {
  const u = await reader("nextday", "203.0.113.72");
  const day1: string[] = [];
  for (const [i, score] of [90, 80, 70, 60].entries()) day1.push(await item(u.source, u.project, score, new Date(N1.getTime() - (i + 1) * 15 * 60_000), `d1 #${i + 1}`));
  assert.deepEqual(await ensureIssue(u.userId, { now: N1 }), { date: DAY1, created: true });
  assert.equal((await readIssue(u.userId, DAY1))!.no, 1);
  // Entries that must not reach issue 2: the 4th article of day 1 (entered before the first cutoff)
  // and one listed after the 00:00 UTC cut.
  await item(u.source, u.project, 88, new Date(N1.getTime() - 30 * 60_000), "before cutoff");
  await item(u.source, u.project, 87, new Date("2026-10-23T00:02:00Z"), "after midnight");
  const kept = [
    await item(u.source, u.project, 99, new Date(N1.getTime() + 30 * 60_000), "d2 top"),
    await item(u.source, u.project, 86, new Date(N1.getTime() + 90 * 60_000), "d2 mid"),
    await item(u.source, u.project, 75, new Date(N1.getTime() + 5 * 3_600_000), "d2 low"),
  ];
  assert.deepEqual(await ensureIssue(u.userId, { now: N2 }), { date: DAY2, created: true });
  const issue = await readIssue(u.userId, DAY2);
  assert.deepEqual([issue!.date, issue!.no], [DAY2, 2]);
  assert.deepEqual(issue!.items.map((i) => i.id), [kept[0], kept[1], kept[2]], "only entries in (day-1 cutoff, 00:00 UTC]");
  assert.ok(!issue!.items.some((i) => i.id === day1[3]), "the 4th article of day 1 stays out");

  const b = await buildUserIssue(u.userId, { now: N2 });
  assert.equal(b.issueCount, 2);
  const titles1 = (await issueTitlesOf(DAY1, u.userId)).map((i) => i.title);
  assert.deepEqual(b.archive, [{ date: DAY1, no: 1, titles: titles1 }], "day 1 in the archive, newest first, without the displayed day");
  assert.equal(await issueCount(u.userId), 2);
});

test("a short day is filled from the never-shown candidates of the previous 72 hours", async () => {
  const u = await reader("fill", "203.0.113.81");
  const day1: string[] = [];
  for (const [i, score] of [90, 85, 80, 78, 76].entries()) day1.push(await item(u.source, u.project, score, new Date(N1.getTime() - (i + 1) * 15 * 60_000), `fill #${i + 1}`));
  assert.deepEqual(await ensureIssue(u.userId, { now: N1 }), { date: DAY1, created: true });
  assert.deepEqual((await issueTitlesOf(DAY1, u.userId)).map((r) => r.article_id), day1.slice(0, 3), "day 1 takes the top three");
  const fresh = await item(u.source, u.project, 70, new Date(N1.getTime() + 3_600_000), "fill fresh");
  assert.deepEqual(await ensureIssue(u.userId, { now: N2 }), { date: DAY2, created: true });
  const issue = await readIssue(u.userId, DAY2);
  assert.deepEqual([issue!.no, issue!.items.map((i) => i.id)], [2, [fresh, day1[3], day1[4]]], "the fresh 70 first, then 78, then 76");
  assert.ok(!issue!.items.some((i) => day1.slice(0, 3).includes(i.id)), "none of day 1's articles come back");

  const old = await reader("fill-old", "203.0.113.82");
  const tooOld = await item(old.source, old.project, 99, new Date("2026-10-19T12:00:00Z"), "too old");
  const onlyFresh = await item(old.source, old.project, 60, new Date(N1.getTime() - 60 * 60_000), "only fresh");
  assert.deepEqual(await ensureIssue(old.userId, { now: N1 }), { date: DAY1, created: true });
  assert.deepEqual((await readIssue(old.userId, DAY1))!.items.map((i) => i.id), [onlyFresh], "the first issue stays in its last-24h window");
  assert.deepEqual(await ensureIssue(old.userId, { now: N2 }), { date: DAY2, created: true });
  const empty = await readIssue(old.userId, DAY2);
  assert.equal(empty!.no, null, "the 99 is older than 72 hours before the cutoff");
  assert.ok(!empty!.items.some((i) => i.id === tooOld));
});

test("once in an issue, never again — even re-listed with a later entry and a higher score", async () => {
  const u = await reader("norepeat", "203.0.113.73");
  const shown = await item(u.source, u.project, 90, new Date(N1.getTime() - 30 * 60_000), "shown");
  assert.deepEqual(await ensureIssue(u.userId, { now: N1 }), { date: DAY1, created: true });
  assert.deepEqual((await issueTitlesOf(DAY1, u.userId)).map((r) => r.article_id), [shown]);
  // The same article, re-listed much later with a higher score.
  await sql`UPDATE publications SET listed_at = ${new Date("2026-10-22T23:30:00Z")}, visible_after = ${new Date("2026-10-22T23:30:00Z")}, score = 95 WHERE article_id = ${shown}`;
  await sql`UPDATE project_scores SET score = 95, scores = ${[95, 95]} WHERE article_id = ${shown}`;
  assert.deepEqual(await ensureIssue(u.userId, { now: N2 }), { date: DAY2, created: true });
  const [row2] = await sql<{ issue_no: number | null }[]>`SELECT issue_no FROM user_issues WHERE user_id = ${u.userId} AND issue_date = ${DAY2}`;
  assert.equal(row2!.issue_no, null, "nothing else qualified, so the day is empty — the article never came back");
  assert.equal(await issueCount(u.userId), 1);
});

test("hero: three items where the top leads by 10 or more", async () => {
  const lead = await reader("lead", "203.0.113.74");
  const close = await reader("close", "203.0.113.75");
  const listed = [N1, new Date(N1.getTime() - 60_000), new Date(N1.getTime() - 120_000)];
  await Promise.all([91, 76, 74].map((score, i) => item(lead.source, lead.project, score, listed[i], `lead #${i + 1}`)));
  await Promise.all([82, 80, 77].map((score, i) => item(close.source, close.project, score, listed[i], `close #${i + 1}`)));
  await ensureIssue(lead.userId, { now: N1 });
  await ensureIssue(close.userId, { now: N1 });
  assert.equal((await readIssue(lead.userId, DAY1))!.hero, true);
  assert.equal((await readIssue(close.userId, DAY1))!.hero, false);
});

test("an empty day keeps its row; the numbers do not skip", async () => {
  const u = await reader("empty", "203.0.113.76");
  await item(u.source, u.project, 70, new Date(N1.getTime() - 30 * 60_000), "day1");
  await ensureIssue(u.userId, { now: N1 });
  assert.deepEqual(await ensureIssue(u.userId, { now: N2 }), { date: DAY2, created: true }, "an empty day is always written");
  const emptyIssue = await readIssue(u.userId, DAY2);
  assert.equal(emptyIssue!.no, null);
  assert.ok(emptyIssue!.ready, "an empty issue is ready");
  await item(u.source, u.project, 75, new Date("2026-10-23T12:00:00Z"), "day3");
  assert.deepEqual(await ensureIssue(u.userId, { now: new Date("2026-10-24T02:00:00Z") }), { date: DAY3, created: true });
  const [row3] = await sql<{ issue_no: number }[]>`SELECT issue_no FROM user_issues WHERE user_id = ${u.userId} AND issue_date = ${DAY3}`;
  assert.equal(row3!.issue_no, 2, "the number continues, no skip");
  assert.deepEqual((await listArchive(u.userId)).map((a) => [a.date, a.no]), [[DAY3, 2], [DAY1, 1]], "empty days are not in the archive");
  assert.equal(await issueCount(u.userId), 2);
});

test("the score floor: below ISSUE_MIN_SCORE never enters, a short issue is not padded, none at all is an empty day", async () => {
  assert.equal(ISSUE_MIN_SCORE, 50);
  const u = await reader("floor", "203.0.113.83");
  const kept = await item(u.source, u.project, 72, new Date(N1.getTime() - 15 * 60_000), "floor kept");
  const edge = await item(u.source, u.project, 50, new Date(N1.getTime() - 30 * 60_000), "floor edge");
  for (const [i, score] of [49, 30, 12].entries()) await item(u.source, u.project, score, new Date(N1.getTime() - (i + 3) * 15 * 60_000), `floor filler #${i + 1}`);
  // A filler article the project did not score falls back to its publication score, which is low too.
  await item(u.source, u.project, null, new Date(N1.getTime() - 90 * 60_000), "floor unscored");
  assert.deepEqual(await ensureIssue(u.userId, { now: N1 }), { date: DAY1, created: true });
  const issue = await readIssue(u.userId, DAY1);
  assert.deepEqual(issue!.items.map((i) => [i.id, i.score]), [[kept, 72], [edge, 50]], "two pass, so two show — no 49/30/12 padding");
  assert.equal(issue!.no, 1);
  // The next day only filler arrives (and the earlier 49/30/12 are still unshown): an empty day.
  for (const [i, score] of [45, 28].entries()) await item(u.source, u.project, score, new Date(N1.getTime() + (i + 1) * 3_600_000), `floor day2 #${i + 1}`);
  assert.deepEqual(await ensureIssue(u.userId, { now: N2 }), { date: DAY2, created: true });
  const empty = await readIssue(u.userId, DAY2);
  assert.equal(empty!.no, null, "nothing passes the floor: the calm empty day");
  assert.equal(empty!.items.length, 0);
});

test("the first ever with no candidates: nothing is written", async () => {
  const u = await reader("void", "203.0.113.77");
  assert.equal(await ensureIssue(u.userId, { now: N1 }), null);
  assert.equal((await sql`SELECT 1 FROM user_issues WHERE user_id = ${u.userId}`).length, 0, "no row written");
  const b = await buildUserIssue(u.userId, { now: N1 });
  assert.equal(b.issue, null, "the client shows 第一期正在准备");
  assert.equal(b.issueCount, 0);
});

test("opened: only an article of one of the user's issues, idempotent, visible in the snapshot", async () => {
  const u = await reader("opened", "203.0.113.78");
  const shown = await item(u.source, u.project, 88, new Date(N1.getTime() - 30 * 60_000), "read me");
  await item(u.source, u.project, 70, new Date(N1.getTime() - 120 * 60_000), "also shown");
  await ensureIssue(u.userId, { now: N1 });
  const stranger = (await upsertMaterial({ sourceId: u.source, url: `https://example.org/is-${T}/stranger`, title: `stranger ${T}`, bodyText: "Body.", bodyStatus: "ok", via: "fetch", publishedAt: N1 })).articleId;
  assert.equal(await recordOpened(u.userId, shown), true);
  assert.equal(await recordOpened(u.userId, shown), true, "reading it again changes nothing");
  assert.equal(await recordOpened(u.userId, stranger), false);
  assert.deepEqual((await buildUserIssue(u.userId, { now: N1 })).opened, [shown]);
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_issue_reads WHERE user_id = ${u.userId} AND article_id = ${stranger}`)[0]!.n, 0, "no read row for a stranger article");
});

test("card copy rides on the issue: readIssue serves it and the archive shows title_a", async () => {
  const u = await reader("copy", "203.0.113.79");
  const ids: string[] = [];
  for (const [i, score] of [91, 84, 62].entries()) ids.push(await item(u.source, u.project, score, new Date(N1.getTime() - (i + 1) * 20 * 60_000), `copy #${i + 1}`));
  assert.deepEqual(await ensureIssue(u.userId, { now: N1 }), { date: DAY1, created: true });
  await sql`INSERT INTO issue_card_copy (project_id, article_id, prompt_version, title_a, title_b, core_a, core_b, summary, tag, source_short, over_budget)
            VALUES (${u.project}, ${ids[0]}, 'test', ${`头条一 ${T}`}, ${"Microduck"}, ${`核心一甲。`}, ${"核心一乙。"}, ${`摘要一 ${T}`}, ${"sim-to-real"}, ${"HF·"}, false),
                   (${u.project}, ${ids[1]}, 'test', ${`头条二 ${T}`}, '', ${"核心二甲。"}, '', ${`摘要二 ${T}`}, '', '', true)`;
  const issue = await readIssue(u.userId, DAY1);
  assert.equal(issue!.ready, false, "the third item has no copy yet");
  const [a, b2, c] = issue!.items;
  assert.deepEqual([a!.title_a, a!.title_b, a!.core_a, a!.core_b, a!.summary, a!.tag, a!.source, a!.hasCopy, a!.overBudget],
    [`头条一 ${T}`, "Microduck", "核心一甲。", "核心一乙。", `摘要一 ${T}`, "sim-to-real", "HF·", true, false]);
  assert.deepEqual([b2!.title_a, b2!.source, b2!.hasCopy, b2!.overBudget], [`头条二 ${T}`, `UT issue copy ${T}`, true, true]);
  assert.deepEqual([c!.title_a, c!.hasCopy], [await pubTitle(c!.id), false]);
  await sql`INSERT INTO issue_card_copy (project_id, article_id, prompt_version, title_a, title_b, core_a, core_b, summary, tag, source_short, over_budget)
            VALUES (${u.project}, ${ids[2]}, 'test', ${`头条三 ${T}`}, '', ${"核心三甲。"}, '', ${`摘要三 ${T}`}, '', '', false)`;
  assert.equal((await readIssue(u.userId, DAY1))!.ready, true, "every item now has copy");
  assert.deepEqual((await listArchive(u.userId))[0], { date: DAY1, no: 1, titles: [`头条一 ${T}`, `头条二 ${T}`, `头条三 ${T}`] });
});

test("the API serves the issue snapshot and the archive to the signed-in user only", async () => {
  const u = await reader("api", "203.0.113.80");
  const headers = { cookie: `${SESSION_COOKIE}=${u.token}`, "content-type": "application/json" };
  const top = await item(u.source, u.project, 91, new Date(Date.now() - 10 * 60_000), "api top");
  await item(u.source, u.project, 78, new Date(Date.now() - 20 * 60_000), "api second");
  const today = new Date().toISOString().slice(0, 10);

  const todayPayload = await (await app.inject({ method: "GET", url: "/api/me/today", headers })).json();
  assert.equal(todayPayload.schemaVersion, 3);
  assert.equal(todayPayload.kind, "user-issue");
  assert.equal(todayPayload.issue!.date, today);
  assert.equal(todayPayload.issue!.no, 1);
  assert.deepEqual(todayPayload.issue!.items.map((i: { position: number }) => i.position), [1, 2]);
  assert.equal((await app.inject({ method: "GET", url: "/api/me/today" })).statusCode, 401);

  const issues = await (await app.inject({ method: "GET", url: "/api/me/issues", headers })).json();
  assert.deepEqual(Object.keys(issues).sort(), ["archive", "issueCount"]);
  assert.equal(issues.issueCount, 1);
  assert.deepEqual(issues.archive, [], "往期 leaves out the issue 今日 shows, as clients show it");

  const dated = await (await app.inject({ method: "GET", url: `/api/me/issues/${today}`, headers })).json();
  assert.equal(dated.issue!.date, today);
  assert.equal((await app.inject({ method: "GET", url: "/api/me/issues/2020-01-01", headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/me/issues/2026-02-30", headers })).statusCode, 404, "not a day: 404, not a 500");
  assert.equal((await app.inject({ method: "GET", url: "/api/me/issues/2026-10-2", headers })).statusCode, 400, "no-day-no-date");
  assert.equal((await app.inject({ method: "GET", url: "/api/me/issues/not-a-date", headers })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: `/api/me/issues/${today}` })).statusCode, 401);

  const read = await app.inject({ method: "POST", url: "/api/me/issues/read", headers, payload: JSON.stringify({ articleId: top }) });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), { ok: true });
  assert.ok((await (await app.inject({ method: "GET", url: "/api/me/today", headers })).json()).opened.includes(top));
  assert.equal((await app.inject({ method: "POST", url: "/api/me/issues/read", headers, payload: JSON.stringify({ articleId: "is-nobody" }) })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/me/issues/read", headers, payload: JSON.stringify({}) })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/me/issues/read", headers: { "content-type": "application/json" }, payload: JSON.stringify({ articleId: top }) })).statusCode, 401);
});

test("isIssueDate: real calendar days only", () => {
  for (const d of ["2026-10-30", "2024-02-29"]) assert.equal(isIssueDate(d), true, d);
  for (const d of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-10-2", "not-a-date", "", "2026-10-30x"]) assert.equal(isIssueDate(d), false, d);
});

test("listPastIssues: the shown day is out, earlier days in; before today's is fixed, yesterday's is the shown one", async () => {
  const u = await reader("past", "203.0.113.81");
  await item(u.source, u.project, 90, new Date(Date.now() - 10 * 60_000), "past top");
  const now = new Date();
  await ensureIssue(u.userId, { now });
  const today = now.toISOString().slice(0, 10);
  assert.deepEqual(await listPastIssues(u.userId, { now }), [], "today's is on 今日");
  const tomorrow = new Date(now.getTime() + 86_400_000);
  assert.deepEqual((await listPastIssues(u.userId, { now: tomorrow })).map((a) => a.date), [], "tomorrow before its issue is fixed, today's is still the shown one");
  assert.deepEqual((await listArchive(u.userId)).map((a) => a.date), [today]);
});

test("per-source cap: one source never takes all three cards, the next best other source does", async () => {
  assert.equal(MAX_PER_SOURCE, 2);
  const u = await reader("cap", "203.0.113.90");
  const [paper, news] = [u.all[0]!, u.all[1]!];
  const p = [];
  for (const [i, score] of [95, 92, 90, 88].entries()) p.push(await itemFrom(paper, u.project, score, new Date(N1.getTime() - (i + 1) * 10 * 60_000), `cap paper #${i + 1}`));
  const n1 = await itemFrom(news, u.project, 61, new Date(N1.getTime() - 60 * 60_000), "cap news");
  await itemFrom(news, u.project, 40, new Date(N1.getTime() - 70 * 60_000), "cap news below floor");
  assert.deepEqual(await ensureIssue(u.userId, { now: N1 }), { date: DAY1, created: true });
  const issue = await readIssue(u.userId, DAY1);
  assert.deepEqual(issue!.items.map((i) => i.id), [p[0], p[1], n1], "two papers, then the best other source; the lead is still the top score");
  assert.equal(issue!.items[0]!.score, 95);
});

test("per-source cap: fewer than two sources above the floor means fewer cards, never filler", async () => {
  const u = await reader("capone", "203.0.113.91");
  const [only, other] = [u.all[0]!, u.all[1]!];
  const ids = [];
  for (const [i, score] of [90, 85, 80].entries()) ids.push(await itemFrom(only, u.project, score, new Date(N1.getTime() - (i + 1) * 10 * 60_000), `capone #${i + 1}`));
  await itemFrom(other, u.project, 49, new Date(N1.getTime() - 50 * 60_000), "capone below floor");
  await ensureIssue(u.userId, { now: N1 });
  assert.deepEqual((await readIssue(u.userId, DAY1))!.items.map((i) => i.id), [ids[0], ids[1]], "two cards: the third paper is capped, the 49 stays out");
});

test("per-source cap: the fill from earlier days counts the fresh cards' sources", async () => {
  const u = await reader("capfill", "203.0.113.92");
  const [paper, news] = [u.all[0]!, u.all[1]!];
  await itemFrom(news, u.project, 70, new Date(N1.getTime() - 30 * 60_000), "capfill day1");
  await ensureIssue(u.userId, { now: N1 });
  // Never shown, before the day-1 cutoff: the fill pool. Two papers and one news item.
  const oldPaper = await itemFrom(paper, u.project, 89, new Date(N1.getTime() - 3 * 3_600_000), "capfill old paper");
  await itemFrom(paper, u.project, 88, new Date(N1.getTime() - 4 * 3_600_000), "capfill old paper 2");
  const oldNews = await itemFrom(news, u.project, 55, new Date(N1.getTime() - 5 * 3_600_000), "capfill old news");
  // Day 2's own window: two papers, so the paper source is already at its cap.
  const fresh = [
    await itemFrom(paper, u.project, 80, new Date(N1.getTime() + 60 * 60_000), "capfill fresh 1"),
    await itemFrom(paper, u.project, 78, new Date(N1.getTime() + 2 * 3_600_000), "capfill fresh 2"),
  ];
  await ensureIssue(u.userId, { now: N2 });
  const ids = (await readIssue(u.userId, DAY2))!.items.map((i) => i.id);
  assert.deepEqual(ids, [fresh[0], fresh[1], oldNews], "the 89/88 older papers are skipped for the other source's 55");
  assert.ok(!ids.includes(oldPaper));
});

// A host suspended through several 08:00 fix points (prod: 11-05..11-09): a late wake recovers the
// day without inventing issues for the days it slept through.
test("a box asleep through several fix points: one late issue on wake, cut at 08:00 of the wake day; skipped days get no row; later items roll on", async () => {
  const u = await reader("asleep", "203.0.113.91");
  // Issue A is fixed normally on 2026-11-05 (08:00 Taipei = 00:00 UTC).
  const issueA = await item(u.source, u.project, 70, new Date("2026-11-04T20:00:00Z"), "issue A item");
  assert.deepEqual(await ensureIssue(u.userId, { now: new Date("2026-11-05T00:00:00Z") }), { date: "2026-11-05", created: true });
  // While asleep only items collected before it slept exist.
  const beforeSleep = await item(u.source, u.project, 72, new Date("2026-11-05T00:10:00Z"), "before sleep");
  // Wake at 2026-11-09T06:54:00Z (14:54 Taipei); the "after wake" item listed at 06:55:00Z is after the 08:00 cutoff.
  const afterWake = await item(u.source, u.project, 90, new Date("2026-11-09T06:55:00Z"), "after wake");
  assert.deepEqual(await ensureIssue(u.userId, { now: new Date("2026-11-09T06:54:30Z") }), { date: "2026-11-09", created: true });
  const dates = await sql<{ d: string }[]>`SELECT to_char(issue_date,'YYYY-MM-DD') d FROM user_issues WHERE user_id=${u.userId} ORDER BY 1`;
  assert.deepEqual(dates.map((r) => r.d), ["2026-11-05", "2026-11-09"]);
  const [row] = await sql<{ issue_no: number | null; cutoff: Date; window_since: Date }[]>`SELECT issue_no, cutoff, window_since FROM user_issues WHERE user_id=${u.userId} AND issue_date='2026-11-09'::date`;
  assert.equal(row!.issue_no, 2);
  assert.equal(row!.cutoff.toISOString(), "2026-11-09T00:00:00.000Z");
  assert.equal(row!.window_since.toISOString(), "2026-11-05T00:00:00.000Z");
  const ids1109 = (await readIssue(u.userId, "2026-11-09"))!.items.map((i) => i.id);
  assert.ok(ids1109.includes(beforeSleep), "the before-sleep item is in the 11-09 issue");
  assert.ok(!ids1109.includes(afterWake), "the after-wake item (listed after the 00:00Z cutoff) waits for 11-10");
  assert.ok(!ids1109.includes(issueA), "issue A's item never comes back");
  // Roll the clock to the next fix point so the after-wake item (listed after 11-09's 00:00Z cutoff) waits for 11-10.
  assert.deepEqual(await ensureIssue(u.userId, { now: new Date("2026-11-10T00:00:00Z") }), { date: "2026-11-10", created: true });
  const ids1110 = (await readIssue(u.userId, "2026-11-10"))!.items.map((i) => i.id);
  assert.ok(ids1110.includes(afterWake), "the after-wake item rolled on to 11-10, not lost");
  assert.deepEqual(await ensureIssue(u.userId, { now: new Date("2026-11-09T07:30:00Z") }), { date: "2026-11-09", created: false });
});
