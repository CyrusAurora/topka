// The web reminder (P0): a private Atom feed of one reader's daily issue. The token is the only
// credential (stored hashed, shown once, rotated on demand); the feed carries only that reader's own
// fixed issues, links the originals and the reader's /issue page, and waits for the card copy.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { createProject } from "@topka/backend/projects/create-project";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";
import { disableIssueFeed, issueFeedXml, rotateIssueFeed, userForIssueFeed } from "@topka/backend/projects/issue-feed";
import { stopBoss } from "@topka/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SRC = `if-src-${T}`;
const app = await buildApp();
let seq = 0;

async function reader() {
  seq++;
  const r = await registerWithInvite({ code: "", email: `feed-${T}-${seq}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: `203.0.113.${100 + seq}` }, sql, "open");
  return { id: r.user.id, cookie: `${SESSION_COOKIE}=${r.token}` };
}

/** One fixed issue of three publications for the user; `copy` writes the card copy for item 1..3. */
let fixtures = 0;
async function issueFor(user: string, date: string, opts: { copy: boolean; fixedAgoMs: number }) {
  const f = ++fixtures;
  const project = (await createProject({ ownerId: user, target: `机器人 ${T}-${f}-${date}`, purpose: "跟踪机器人", sources: [{ sourceId: SRC, required: false }] })).project.id;
  const listed = new Date(Date.now() - 3 * 3600_000);
  const ids: string[] = [];
  for (const k of ["a", "b", "c"]) {
    const path = `if-${T}-${f}-${date}-${k}`;
    const id = (await upsertMaterial({ sourceId: SRC, url: `https://example.org/${path}`, title: `原题 ${path}`, bodyText: `Body ${path}`, bodyStatus: "ok", via: "fetch", publishedAt: listed })).articleId;
    await sql`INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, score, visible_after, listed_at)
              VALUES (${id}, ${`中文 ${path}`}, ${`原题 ${path}`}, ${`摘要 ${path}`}, ${SRC}, 'news', ${`https://example.org/${path}`}, ${listed}, ${listed}, ${listed}, ${listed}, true, 60, ${listed}, ${listed})`;
    ids.push(id);
  }
  const fixedAt = new Date(Date.now() - opts.fixedAgoMs);
  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_issues WHERE user_id = ${user} AND issue_no IS NOT NULL`;
  await sql`INSERT INTO user_issues (user_id, issue_date, issue_no, cutoff, window_since, hero, fixed_at) VALUES (${user}, ${date}, ${n!.n + 1}, ${fixedAt}, ${fixedAt}, false, ${fixedAt})`;
  for (const [i, id] of ids.entries()) {
    await sql`INSERT INTO user_issue_items (user_id, issue_date, position, article_id, project_id, story_id, score, listed_at) VALUES (${user}, ${date}, ${i + 1}, ${id}, ${project}, null, 80, ${fixedAt})`;
    if (opts.copy) {
      await sql`INSERT INTO issue_card_copy (project_id, article_id, prompt_version, title_a, title_b, core_a, core_b, summary, tag, source_short)
                VALUES (${project}, ${id}, 'test', ${i === 1 ? "Robot Report：" : `卡片标题${i + 1} <b>&`}, ${i === 1 ? "人形订单回升" : ""}, ${`核心${i + 1}`}, '', ${`卡片摘要${i + 1}`}, '', '短源')`;
    }
  }
  return ids;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES (${SRC}, ${`Feed ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});

after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

test("tokens: random, stored hashed, rotation retires the old one, disable and junk resolve to nobody", async () => {
  const r = await reader();
  const a = await rotateIssueFeed(r.id);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  const [row] = await sql<{ token_hash: string }[]>`SELECT token_hash FROM user_issue_feeds WHERE user_id = ${r.id}`;
  assert.notEqual(row!.token_hash, a, "only the hash is stored");
  assert.equal(await userForIssueFeed(a), r.id);
  const b = await rotateIssueFeed(r.id);
  assert.notEqual(a, b);
  assert.equal(await userForIssueFeed(a), null, "the old URL stops working");
  assert.equal(await userForIssueFeed(b), r.id);
  assert.equal(await userForIssueFeed("../../etc/passwd"), null);
  assert.equal(await disableIssueFeed(r.id), true);
  assert.equal(await userForIssueFeed(b), null);
});

test("the feed carries only the reader's own ready issues, newest first, linking originals and /issue", async () => {
  const me = await reader();
  const other = await reader();
  const mine = await issueFor(me.id, "2026-10-20", { copy: true, fixedAgoMs: 9 * 86400_000 });
  await issueFor(me.id, "2026-10-21", { copy: false, fixedAgoMs: 8 * 86400_000 }); // never got copy, long past the grace: shown with raw titles
  await issueFor(me.id, "2026-10-22", { copy: false, fixedAgoMs: 10 * 60_000 }); // copy still being written: held back
  const theirs = await issueFor(other.id, "2026-10-20", { copy: true, fixedAgoMs: 9 * 86400_000 });
  const token = await rotateIssueFeed(me.id);
  const xml = await issueFeedXml(me.id, token);
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom"/);
  const entries = xml.split("<entry>").slice(1);
  assert.equal(entries.length, 2, xml);
  assert.ok(entries[0]!.includes("/issue/2026-10-21") && entries[1]!.includes("/issue/2026-10-20"), "newest first");
  // By its link: a bare "2026-10-22" also matches the 10-21 issue's fixed_at (now - 8 days) on 10-30 UTC.
  assert.ok(!xml.includes("/issue/2026-10-22"), "an issue whose copy is still being written waits");
  assert.ok(entries[1]!.includes("第 1 期") && entries[1]!.includes("10月20日"), entries[1]);
  assert.ok(entries[1]!.includes("卡片标题1 &amp;lt;b&amp;gt;&amp;amp;"), "card copy is escaped inside the html content");
  // A split title is named whole (the lead「Robot Report：」alone reads like nothing), glued after 「：」.
  const summary = entries[1]!.match(/<summary>(.*)<\/summary>/)![1]!;
  assert.ok(summary.includes(" / Robot Report：人形订单回升 / "), summary);
  assert.ok(entries[1]!.includes("Robot Report：人形订单回升"), "the html content names the whole title too");
  for (const id of mine) {
    const [p] = await sql<{ url: string }[]>`SELECT url FROM publications WHERE article_id = ${id}`;
    assert.ok(xml.includes(p!.url), "each item links its original");
  }
  for (const id of theirs) {
    const [p] = await sql<{ url: string }[]>`SELECT url FROM publications WHERE article_id = ${id}`;
    assert.ok(!xml.includes(p!.url), "another reader's issue never shows");
  }
  assert.ok(xml.includes(`/feed/issue/${token}.xml`), "self link");
  assert.ok(!xml.includes(me.id), "the user id is not in the feed");
});

test("over HTTP: the settings door needs the session; the feed answers by token only", async () => {
  const me = await reader();
  await issueFor(me.id, "2026-10-18", { copy: true, fixedAgoMs: 11 * 86400_000 });
  const anon = await app.inject({ method: "POST", url: "/api/me/issue-feed" });
  assert.equal(anon.statusCode, 401);
  const off = await app.inject({ method: "GET", url: "/api/me/issue-feed", headers: { cookie: me.cookie } });
  assert.equal(off.json().enabled, false);
  const on = await app.inject({ method: "POST", url: "/api/me/issue-feed", headers: { cookie: me.cookie } });
  assert.equal(on.statusCode, 200, on.body);
  const url = new URL(on.json().url as string);
  assert.match(url.pathname, /^\/feed\/issue\/[A-Za-z0-9_-]{43}\.xml$/);
  assert.equal((await app.inject({ method: "GET", url: "/api/me/issue-feed", headers: { cookie: me.cookie } })).json().enabled, true);

  const feed = await app.inject({ method: "GET", url: url.pathname });
  assert.equal(feed.statusCode, 200, feed.body);
  assert.match(String(feed.headers["content-type"]), /application\/atom\+xml/);
  assert.equal(feed.headers["cache-control"], "private, max-age=300");
  assert.equal(feed.headers["x-robots-tag"], "noindex, nofollow");
  assert.ok(feed.body.includes("/issue/2026-10-18"));
  const again = await app.inject({ method: "GET", url: url.pathname, headers: { "if-none-match": String(feed.headers.etag) } });
  assert.equal(again.statusCode, 304);

  assert.equal((await app.inject({ method: "GET", url: "/feed/issue/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.xml" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/feed/issue/short.xml" })).statusCode, 404);
  const del = await app.inject({ method: "DELETE", url: "/api/me/issue-feed", headers: { cookie: me.cookie } });
  assert.equal(del.json().enabled, false);
  assert.equal((await app.inject({ method: "GET", url: url.pathname })).statusCode, 404, "a disabled feed is gone");
});
