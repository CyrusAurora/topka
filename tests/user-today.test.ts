// The per-user today (今日): all of the user's projects merged, an article several projects follow
// counted once under its best project score, one card per event, TODAY_CARD_COUNT cards; 看过了 /
// 稍后看 marks ride on the cards, 稍后看 items stay reachable, and the user-level checkpoint only
// moves forward. Clients moved to the daily model in issues.ts; this module stays for
// the web export and card-copy scripts. The API of this suite: only /mark and /ack still answer here.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";
import { createProject } from "@topka/backend/projects/create-project";
import { buildUserToday, markItem, nextFreshAt } from "@topka/backend/projects/user-today";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const S1 = `ut-1-${T}`;
const S2 = `ut-2-${T}`;
const app = await buildApp();
let user: { token: string; id: string };
let p1: string;
let p2: string;

let seq = 0;
async function item(sourceId: string, title: string, scores: Record<string, number>, opts: { generic?: number; story?: string; minutesAgo?: number } = {}) {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.org/ut-${T}/${++seq}`, title: `${title} ${T}`, bodyText: "Body.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  const listed = new Date(Date.now() - (opts.minutesAgo ?? 5) * 60_000);
  await sql`
    INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, score, visible_after, listed_at, story_id)
    VALUES (${articleId}, ${`中文 ${title}`}, ${`${title} ${T}`}, ${`摘要 ${title}`}, ${sourceId}, 'news', ${`https://example.org/ut-${T}/${seq}`}, ${listed}, ${listed}, ${listed}, ${listed}, true, ${opts.generic ?? null}, ${listed}, ${listed}, ${opts.story ?? null})`;
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${articleId}`;
  for (const [project, score] of Object.entries(scores)) {
    await sql`INSERT INTO project_scores (project_id, article_id, source_id, input_revision, project_revision, scores, score, prompt_version)
              VALUES (${project}, ${articleId}, ${sourceId}, 1, 1, ${[score, score]}, ${score}, 'test')`;
  }
  return articleId;
}
const titles = (b: { items: Array<{ originalTitle: string | null; title: string }> }) => b.items.map((i) => (i.originalTitle ?? i.title).replace(` ${T}`, ""));

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES
    (${S1}, ${`UT one ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01'), (${S2}, ${`UT two ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  const code = (await createInvite({ createdBy: `t-${T}`, maxUses: 1, expiresInDays: 7, note: "ut" })).code;
  const r = await registerWithInvite({ code, email: `ut-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.60" });
  user = { token: r.token, id: r.user.id };
  p1 = (await createProject({ ownerId: user.id, target: `机器人 ${T}`, purpose: "跟踪", sources: [{ sourceId: S1, required: false }, { sourceId: S2, required: false }] })).project.id;
  p2 = (await createProject({ ownerId: user.id, target: `电池 ${T}`, purpose: "跟踪", sources: [{ sourceId: S2, required: false }] })).project.id;
});
after(async () => {
  await app.close();
  await closeDb();
});

test("all projects merged: best project score per article, one card per event, three cards", async () => {
  const story = (await sql<{ id: string }[]>`INSERT INTO stories (public_id, title) VALUES (gen_random_uuid(), ${`ut ${T}`}) RETURNING id`)[0]!.id;
  await item(S1, "robot big", { [p1]: 80 });
  await item(S2, "shared", { [p1]: 30, [p2]: 85 }, { generic: 99 });
  await item(S1, "event a", { [p1]: 70 }, { story });
  await item(S1, "event b", { [p1]: 75 }, { story });
  await item(S2, "battery low", { [p2]: 20 });
  const b = await buildUserToday(user.id);
  assert.equal(b.kind, "user-today");
  assert.deepEqual(titles(b), ["shared", "robot big", "event b"]);
  const shared = b.items[0]!;
  assert.deepEqual([shared.score, shared.scoreBasis, shared.project.id, shared.projectIds.length], [85, "project", p2, 2], "counted once, under its best project");
  assert.deepEqual([b.cardCount, b.candidates, b.quietDay, b.quietNote, b.bestId], [3, 4, false, null, shared.id]);
  assert.equal(b.projects.length, 2);
});

test("marks ride on the cards, 稍后看 stays reachable, the checkpoint only moves forward, /mark and /ack answer to the signed-in user only", async () => {
  const headers = { cookie: `${SESSION_COOKIE}=${user.token}`, "content-type": "application/json" };
  const first = await buildUserToday(user.id);
  assert.equal(first.items.length, 3);
  const [a, b2] = first.items;
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/me/today/mark", headers, payload: JSON.stringify({ articleId: a!.id, mark: "seen" }) })).json(), { ok: true });
  assert.equal((await app.inject({ method: "POST", url: "/api/me/today/mark", headers, payload: JSON.stringify({ articleId: b2!.id, mark: "later" }) })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/me/today/mark", headers, payload: JSON.stringify({ articleId: "nope", mark: "seen" }) })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/me/today/mark", headers, payload: JSON.stringify({ articleId: a!.id, mark: "maybe" }) })).statusCode, 400);
  const marked = await buildUserToday(user.id);
  assert.deepEqual(marked.items.map((i) => i.mark), ["seen", "later", null]);
  assert.equal((await app.inject({ method: "GET", url: "/api/me/today" })).statusCode, 401);

  const ack = await app.inject({ method: "POST", url: "/api/me/today/ack", headers, payload: JSON.stringify({ through: first.window.until }) });
  assert.equal(ack.statusCode, 200, ack.body);
  const afterAck = await buildUserToday(user.id);
  assert.equal(afterAck.result, "no-important-change");
  assert.equal(afterAck.window.basis, "checkpoint");
  assert.deepEqual(afterAck.later.map((l) => l.id), [b2!.id], "稍后看 items stay reachable after the read");
  const older = await app.inject({ method: "POST", url: "/api/me/today/ack", headers, payload: JSON.stringify({ through: new Date(Date.parse(first.window.until) - 3_600_000).toISOString() }) });
  assert.equal(older.json().checkpoint.advanced, false);
  assert.equal((await app.inject({ method: "POST", url: "/api/me/today/ack", headers, payload: JSON.stringify({ through: "x" }) })).statusCode, 400);
});

test("a weak day still fills its cards and says so", async () => {
  await sql`UPDATE user_read_checkpoints SET read_through = now() - interval '2 hours' WHERE user_id = ${user.id}`;
  await sql`UPDATE project_scores SET score = 10 WHERE project_id IN (${p1}, ${p2})`;
  const b = await buildUserToday(user.id);
  assert.equal(b.items.length, 3);
  assert.deepEqual([b.quietDay, b.quietNote], [true, "今天没大事"]);
});

test("nextFreshAt: the next 08:00 Beijing (00:00 UTC), strictly after", () => {
  assert.equal(nextFreshAt(new Date("2026-10-22T07:59:00Z")).toISOString(), "2026-10-23T00:00:00.000Z");
  assert.equal(nextFreshAt(new Date("2026-10-22T23:59:59Z")).toISOString(), "2026-10-23T00:00:00.000Z");
  assert.equal(nextFreshAt(new Date("2026-10-23T00:00:00Z")).toISOString(), "2026-10-24T00:00:00.000Z");
});
