// Discovery channels and pending-evidence signals against the database (master design 3.2, 8.2 step
// 10; docs/discovery.md): the table refuses what the gate never does; channels store signals only
// (no observation, no source change) and fail per feed; the gate promotes on a saved editorial,
// non-withdrawn observation with the same URL identity and records it as lineage on the reader's
// card; the reader's and the operator's endpoints keep project isolation, the cap and the reasons.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

const T = tag();
process.env.ADMIN_PASSWORD = `disc-admin-${T}-password`;
process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
const { closeDb, sql } = await import("@topka/backend/db");
const { recordMaterial } = await import("@topka/backend/content/materials");
const d = await import("@topka/backend/discovery/signals");
const { createInvite } = await import("@topka/backend/accounts/invite");
const { registerWithInvite } = await import("@topka/backend/accounts/register");
const { SESSION_COOKIE } = await import("@topka/backend/accounts/session");
const { createProject } = await import("@topka/backend/projects/create-project");
const { passwordLogin, SESSION_COOKIE: ADMIN_COOKIE } = await import("@topka/backend/admin/auth");
const { stopBoss } = await import("@topka/backend/jobs/queue");
const { buildApp } = await import("../apps/api/src/app.ts");

const ED = `disc-ed-${T}`;
const DIR1 = `disc-dir1-${T}`;
const DIR2 = `disc-dir2-${T}`;
const PACK = `disc-pack-${T}`;
const HEAT = `disc-heat-${T}`;
const app = await buildApp();
const base = `https://disc-${T}.example.org`;

let feedServer: http.Server;
let feedUrl = "";
const feedXml = (items: Array<{ link: string; title: string; date?: string }>) => `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>${items
  .map((i) => `<item><title>${i.title}</title><link>${i.link}</link>${i.date ? `<pubDate>${i.date}</pubDate>` : ""}</item>`).join("")}</channel></rss>`;

before(async () => {
  feedServer = http.createServer((req, res) => {
    if (req.url === "/broken") return res.writeHead(500).end("no");
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(feedXml([{ link: `${base}/from-real-feed?utm_source=rss`, title: "From the real feed", date: new Date().toUTCString() }]));
  });
  await new Promise<void>((r) => feedServer.listen(0, "127.0.0.1", () => r()));
  feedUrl = `http://127.0.0.1:${(feedServer.address() as { port: number }).port}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at, tags, config, created_at) VALUES
    (${ED}, ${`Editorial ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01', '{}', '{}', now()),
    (${DIR1}, ${`Dir one ${T}`}, 'rss', 'T2', 'hot_signal', false, '2100-01-01', '{directory}', ${sql.json({ feedUrl: `${feedUrl}/ok` })}, '1990-01-01'),
    (${DIR2}, ${`Dir two ${T}`}, 'rss', 'T2', 'hot_signal', false, '2100-01-01', '{directory}', ${sql.json({ feedUrl: `${feedUrl}/broken` })}, '1990-01-02'),
    (${PACK}, ${`Pack feed ${T}`}, 'rss', 'T2', 'hot_signal', false, '2100-01-01', '{}', ${sql.json({ feedUrl: `${feedUrl}/ok` })}, now()),
    (${HEAT}, ${`Heat ${T}`}, 'rss', 'T2', 'hot_signal', true, '2100-01-01', '{}', '{}', now())`;
});
after(async () => {
  await sql`DELETE FROM settings WHERE key IN (${d.SETTINGS_KEY}, ${d.STATE_KEY})`;
  await new Promise<void>((r) => feedServer.close(() => r()));
  await app.close();
  await stopBoss();
  await closeDb();
});

const observe = (url: string, extra: Record<string, unknown> = {}) =>
  recordMaterial({ sourceId: ED, url, title: `Obs ${T} ${url}`, excerpt: "Summary.", via: "fetch", publishedAt: new Date(), ...extra });

test("the table refuses a promotion without lineage, an invalid URL promoted, edits of what a channel reported, and un-promoting", async () => {
  const id = `sig_t1_${T}`;
  await sql`INSERT INTO discovery_signals (id, channel_kind, channel_name, url, url_identity) VALUES (${id}, 'directory', 'x', ${`${base}/t1`}, ${`${base}/t1`})`;
  const refuses = async (label: string, q: Promise<unknown>) => assert.rejects(q, /violates|cannot change|final|restore/, label);
  await refuses("promoted without observation", sql`UPDATE discovery_signals SET status = 'promoted', promoted_at = now() WHERE id = ${id}`);
  await refuses("url edit", sql`UPDATE discovery_signals SET url = 'https://other.example/' WHERE id = ${id}`);
  await refuses("channel edit", sql`UPDATE discovery_signals SET channel_name = 'y' WHERE id = ${id}`);
  await refuses("user lead without project", sql`INSERT INTO discovery_signals (id, channel_kind, channel_name, url) VALUES (${`${id}b`}, 'user-lead', 'reader', 'https://e.example/')`);
  await refuses("promoted invalid URL", sql`INSERT INTO discovery_signals (id, channel_kind, channel_name, url, status, promoted_observation_id, promoted_at) VALUES (${`${id}c`}, 'directory', 'x', '/rel', 'promoted', 'o', now())`);
  await refuses("bad kind", sql`INSERT INTO discovery_signals (id, channel_kind, channel_name, url) VALUES (${`${id}d`}, 'search', 'x', 'https://e.example/')`);
  await sql`UPDATE discovery_signals SET status = 'promoted', promoted_observation_id = 'obs-x', promoted_at = now() WHERE id = ${id}`;
  await refuses("un-promote", sql`UPDATE discovery_signals SET status = 'awaiting', promoted_observation_id = NULL, promoted_at = NULL WHERE id = ${id}`);
  await refuses("re-point lineage", sql`UPDATE discovery_signals SET promoted_observation_id = 'obs-y' WHERE id = ${id}`);
  const id2 = `sig_t1b_${T}`;
  await sql`INSERT INTO discovery_signals (id, channel_kind, channel_name, url, url_identity, status, dismissed_at) VALUES (${id2}, 'directory', 'x', ${`${base}/t1b`}, ${`${base}/t1b`}, 'dismissed', now())`;
  await refuses("dismissed straight to promoted", sql`UPDATE discovery_signals SET status = 'promoted', promoted_observation_id = 'o', promoted_at = now(), dismissed_at = NULL WHERE id = ${id2}`);
  await sql`DELETE FROM discovery_signals WHERE id IN (${id}, ${id2})`;
});

test("recordSignal: one row per channel, project and URL; identity stored, null when invalid", async () => {
  const a = await d.recordSignal({ kind: "directory", channelName: `Rec ${T}`, url: ` ${base}/rec/?utm_source=x ` });
  const again = await d.recordSignal({ kind: "directory", channelName: `Rec ${T}`, url: `${base}/rec/?utm_source=x` });
  assert.deepEqual([a.created, again.created, again.id], [true, false, a.id]);
  const bad = await d.recordSignal({ kind: "directory", channelName: `Rec ${T}`, url: "not a url", title: "  spaced\n title ", publishedAt: new Date("x") });
  const rows = await sql<{ id: string; url_identity: string | null; title: string | null; published_at_claim: Date | null }[]>`
    SELECT id, url_identity, title, published_at_claim FROM discovery_signals WHERE id IN (${a.id}, ${bad.id}) ORDER BY url_identity NULLS LAST`;
  assert.deepEqual(rows.map((r) => [r.url_identity, r.title, r.published_at_claim]), [[`${base}/rec`, null, null], [null, "spaced title", null]]);
  assert.notEqual(d.signalId("directory", "n", null, "u"), d.signalId("pack", "n", null, "u"));
  assert.notEqual(d.signalId("user-lead", "reader", "p1", "u"), d.signalId("user-lead", "reader", "p2", "u"));
});

test("channels: directory and pack feeds become signals only; a broken feed is counted; the gate promotes on an editorial observation", async () => {
  const code = (await createInvite({ createdBy: `t-${T}`, maxUses: 1, expiresInDays: 7, note: `disc ${T}` })).code;
  const reader = await registerWithInvite({ code, email: `disc-ch-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.80" });
  const proj = await createProject({ ownerId: reader.user.id, target: `发现 ${T}`, purpose: "跟踪", sources: [{ sourceId: ED, required: false }] });
  await sql`INSERT INTO project_sources (project_id, source_id, role, required, paused) VALUES (${proj.project.id}, ${PACK}, 'optional', false, false)`;
  // An observation that confirms one directory entry, and a withdrawn one that must not.
  const confirmed = await observe(`${base}/confirmed`);
  const withdrawn = await observe(`${base}/withdrawn`);
  await sql`INSERT INTO article_withdrawals (article_id, action, basis, reason, recorded_by) VALUES (${withdrawn.articleId!}, 'withdraw', 'editorial', 'test', 'test')`;
  // A heat-only entry the collector already stored (enabled hot_signal source).
  await recordMaterial({ sourceId: HEAT, url: `${base}/heat-entry`, title: "Heat entry", excerpt: "Heat.", via: "fetch", publishedAt: new Date() });

  await d.saveDiscoverySettings({ feedCount: 2 }, "test");
  const sourcesBefore = await sql`SELECT id, cursor, fail_count, health FROM sources WHERE id IN (${DIR1}, ${DIR2}, ${PACK}) ORDER BY id`;
  const articlesBefore = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles`)[0]!.n;
  const read: string[] = [];
  const reader2 = async (s: { id: string }) => {
    read.push(s.id);
    if (s.id === DIR2) throw new Error("HTTP 500");
    if (s.id === DIR1) return [
      { url: `${base}/confirmed?utm_medium=feed`, title: "Confirmed entry", publishedAt: new Date() },
      { url: `${base}/withdrawn`, title: "Withdrawn entry", publishedAt: null },
      { url: `${base}/old`, title: "Too old", publishedAt: new Date(Date.now() - 30 * 86400_000) },
      { url: "/relative-entry", title: "Invalid entry", publishedAt: null },
    ];
    if (s.id === PACK) return [{ url: `${base}/pack-entry`, title: "Pack entry", publishedAt: new Date() }];
    return [];
  };
  const prev = process.env.COLLECT_ENABLED;
  process.env.COLLECT_ENABLED = "true";
  try {
    const r = await d.collectDiscoveryChannels({ reader: reader2 });
    assert.ok(read.includes(DIR1) && read.includes(DIR2) && read.includes(PACK), "directory (first 2) and pack feeds read");
    assert.ok(r.failed >= 1, "the broken feed is counted");
    assert.ok(r.created >= 4, `stored: ${JSON.stringify(r)}`);
    assert.ok(r.fromHeat >= 1, "the heat entry became a directory signal");
    assert.ok(r.gate.promoted >= 1);
  } finally {
    if (prev === undefined) delete process.env.COLLECT_ENABLED;
    else process.env.COLLECT_ENABLED = prev;
  }
  const sourcesAfter = await sql`SELECT id, cursor, fail_count, health FROM sources WHERE id IN (${DIR1}, ${DIR2}, ${PACK}) ORDER BY id`;
  assert.deepEqual(sourcesAfter, sourcesBefore, "reading a channel never touches its source row");
  const articlesAfter = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles`)[0]!.n;
  assert.equal(articlesAfter, articlesBefore, "no observation is created");

  const rows = await sql<{ url: string; channel_kind: string; status: string; promoted_observation_id: string | null; project_id: string | null }[]>`
    SELECT url, channel_kind, status, promoted_observation_id, project_id FROM discovery_signals WHERE url LIKE ${`${base}/%`} OR url = '/relative-entry' ORDER BY url`;
  const by = new Map(rows.map((x) => [x.url, x]));
  assert.equal(by.get(`${base}/confirmed?utm_medium=feed`)?.status, "promoted");
  assert.equal(by.get(`${base}/confirmed?utm_medium=feed`)?.promoted_observation_id, confirmed.articleId);
  assert.equal(by.get(`${base}/withdrawn`)?.status, "awaiting", "a withdrawn observation confirms nothing");
  assert.equal(by.has(`${base}/old`), false, "entries older than 14 days are skipped");
  assert.equal(by.get("/relative-entry")?.status, "awaiting", "invalid URL kept, never promoted");
  assert.deepEqual([by.get(`${base}/pack-entry`)?.channel_kind, by.get(`${base}/pack-entry`)?.project_id], ["pack", proj.project.id]);
  assert.equal(by.get(`${base}/heat-entry`)?.status, "awaiting", "a heat item cannot confirm itself");

  // The state the catalog shows, and the catalog itself.
  const cat = await d.directoryCatalog();
  const mine = cat.feeds.filter((f) => f.id === DIR1 || f.id === DIR2);
  assert.deepEqual(mine.map((f) => [f.active, f.lastRead?.ok]), [[true, true], [true, false]]);
  assert.equal(cat.feedCount, 2);

  // The reader's today card carries the lineage of the observation it shows.
  const lineage = await d.promotedFor([confirmed.articleId!, "nope"]);
  assert.deepEqual(lineage.get(confirmed.articleId!)?.map((l) => [l.channelName, l.kind]), [[`Dir one ${T}`, "directory"]]);
  assert.deepEqual(await d.promotedFor([]), new Map());

  // A later observation promotes a waiting signal on the next gate run.
  await observe(`${base}/pack-entry/`);
  const g = await d.runPromotionGate();
  assert.ok(g.promoted >= 1 && g.observations >= 1);
  assert.equal((await sql<{ status: string }[]>`SELECT status FROM discovery_signals WHERE url = ${`${base}/pack-entry`}`)[0]!.status, "promoted");
});

test("channels: the real RSS reader through the fetch guard; collection off reads nothing but still runs the gate", async () => {
  await d.saveDiscoverySettings({ feedCount: 1 }, "test");
  const prev = process.env.COLLECT_ENABLED;
  process.env.COLLECT_ENABLED = "true";
  try {
    const r = await d.collectDiscoveryChannels();
    assert.ok(r.feeds >= 1);
  } finally {
    process.env.COLLECT_ENABLED = "false";
  }
  const [row] = await sql<{ channel_name: string; url_identity: string }[]>`SELECT channel_name, url_identity FROM discovery_signals WHERE url = ${`${base}/from-real-feed?utm_source=rss`}`;
  assert.deepEqual(row, { channel_name: `Dir one ${T}`, url_identity: `${base}/from-real-feed` });
  const off = await d.collectDiscoveryChannels({ reader: async () => { throw new Error("must not read"); } });
  assert.deepEqual([off.feeds, off.created], [0, 0]);
  if (prev === undefined) delete process.env.COLLECT_ENABLED;
  else process.env.COLLECT_ENABLED = prev;
});

test("settings: the feed count is an integer in 0..20, anything else is the default 3; 0 reads no directory feed", async () => {
  for (const [raw, expected] of [[0, 0], [20, 20], [21, 3], [-1, 3], [2.5, 3], ["4", 3], [null, 3]] as Array<[unknown, number]>) {
    assert.equal(d.normalizeFeedCount(raw), expected, `feedCount ${JSON.stringify(raw)}`);
  }
  assert.deepEqual(await d.directoryFeeds(0), []);
  await sql`DELETE FROM settings WHERE key = ${d.SETTINGS_KEY}`;
  assert.deepEqual(await d.discoverySettings(), { feedCount: 3 });
});

test("reader endpoints: leads, the capped pending list, dismissal and project isolation", async () => {
  const mk = async (suffix: string, ip: string) => {
    const code = (await createInvite({ createdBy: `t-${T}`, maxUses: 1, expiresInDays: 7, note: `disc ${suffix}` })).code;
    return registerWithInvite({ code, email: `disc-${suffix}-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip });
  };
  const owner = await mk("owner", "203.0.113.81");
  const stranger = await mk("stranger", "203.0.113.82");
  const proj = (await createProject({ ownerId: owner.user.id, target: `线索 ${T}`, purpose: "跟踪", sources: [{ sourceId: ED, required: false }] })).project;
  const cookie = { cookie: `${SESSION_COOKIE}=${owner.token}` };
  const other = { cookie: `${SESSION_COOKIE}=${stranger.token}` };
  const path = `/api/projects/${proj.slug}/signals`;
  const post = (payload: unknown, headers = cookie) => app.inject({ method: "POST", url: path, headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify(payload) });

  assert.equal((await app.inject({ method: "GET", url: "/api/discover" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: path })).statusCode, 404, "signed out reads as not found");
  assert.equal((await app.inject({ method: "GET", url: path, headers: other })).statusCode, 404, "another reader's project is not found");
  assert.equal((await post({ url: `${base}/x` }, other)).statusCode, 404);

  assert.equal((await post({})).json().code, "url_required");
  assert.equal((await post({ url: "   " })).statusCode, 400);
  assert.equal((await post({ url: `${base}/${"a".repeat(5000)}` })).json().code, "too_long");
  assert.equal((await post({ url: `${base}/y`, note: "n".repeat(1001) })).statusCode, 400);

  await observe(`${base}/lead-confirmed`);
  const promoted = await post({ url: `${base}/lead-confirmed/?ref=me`, title: "Confirmed lead", note: "seen on a forum" });
  assert.equal(promoted.statusCode, 201);
  assert.deepEqual([promoted.json().promoted, promoted.json().signal.status], [true, "promoted"]);
  const invalid = await post({ url: "ftp://files.example/x", title: "Not http" });
  assert.deepEqual([invalid.statusCode, invalid.json().signal.invalidUrl, invalid.json().signal.status], [201, true, "awaiting"]);
  assert.equal((await post({ url: "ftp://files.example/x" })).statusCode, 200, "the same lead again is the same signal");
  // The rest straight through the module (the endpoint allows 30 leads a minute).
  for (let i = 0; i < 24; i++) assert.equal((await d.addLead(proj.id, owner.user.id, { url: `${base}/lead-${i}`, title: `Lead ${i}` })).created, true);
  await d.addLead(proj.id, owner.user.id, { url: `${base}/lead-3/` }); // a duplicate of lead-3 by identity: folded

  const list = (await app.inject({ method: "GET", url: path, headers: cookie })).json() as { pending: { items: Array<{ id: string; url: string; duplicates: number }>; total: number; hidden: number; cap: number }; promoted: Array<{ url: string; observation: { title: string } | null }> };
  assert.deepEqual([list.pending.items.length, list.pending.total, list.pending.hidden, list.pending.cap], [20, 25, 5, 20]);
  assert.equal(list.promoted.length, 1);
  assert.match(list.promoted[0]!.observation!.title, /lead-confirmed/);
  const lead3 = list.pending.items.find((i) => i.url === `${base}/lead-3`);
  assert.ok(!lead3 || lead3.duplicates === 1);

  const site = (await app.inject({ method: "GET", url: "/api/discover", headers: cookie })).json() as { catalog: { feeds: unknown[] }; pending: { items: Array<{ projectId: string | null }> }; projects: Array<{ id: string }> };
  assert.ok(Array.isArray(site.catalog.feeds));
  assert.deepEqual(site.projects.map((p) => p.id), [proj.id]);
  const strangerSite = (await app.inject({ method: "GET", url: "/api/discover", headers: other })).json() as { pending: { items: Array<{ projectId: string | null }> } };
  assert.ok(strangerSite.pending.items.every((i) => i.projectId !== proj.id), "another reader never sees this project's leads");

  const target = list.pending.items[0]!;
  assert.equal((await app.inject({ method: "POST", url: `${path}/${target.id}/dismiss`, headers: other, payload: {} })).statusCode, 404);
  const dis = await app.inject({ method: "POST", url: `${path}/${target.id}/dismiss`, headers: { ...cookie, "content-type": "application/json" }, payload: JSON.stringify({ reason: "not relevant" }) });
  assert.equal(dis.json().signal.status, "dismissed");
  assert.equal((await app.inject({ method: "POST", url: `${path}/${target.id}/dismiss`, headers: cookie, payload: {} })).statusCode, 404, "only an awaiting signal can be dismissed");

  // Too many awaiting leads: refused with its reason.
  await sql`INSERT INTO discovery_signals (id, channel_kind, channel_name, url, project_id)
            SELECT 'sig_many_' || g || ${T}, 'user-lead', 'reader', ${`${base}/many-`} || g, ${proj.id} FROM generate_series(1, ${d.MAX_AWAITING_LEADS}) g`;
  assert.equal((await post({ url: `${base}/one-more` })).json().code, "too_many");
});

test("operator endpoints: list, dismiss with a reason, restore (re-checked by the gate), run, settings; all audited", async () => {
  const { token } = await passwordLogin(process.env.ADMIN_PASSWORD!, "/admin", "disc");
  const cookie = `${ADMIN_COOKIE}=${token}`;
  const me = (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } })).json() as { csrf: string };
  const h = { cookie, "x-csrf-token": me.csrf, "content-type": "application/json" };
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/discovery" })).statusCode, 401);
  const s = await d.recordSignal({ kind: "directory", channelName: `Op ${T}`, url: `${base}/op` });
  const list = (await app.inject({ method: "GET", url: "/api/admin/discovery?status=awaiting&kind=directory", headers: { cookie } })).json() as { rows: Array<{ id: string; status: string; kind: string }>; counts: Record<string, number>; catalog: { feeds: unknown[] } };
  assert.ok(list.rows.some((r) => r.id === s.id));
  assert.ok(list.rows.every((r) => r.status === "awaiting" && r.kind === "directory"));
  assert.ok(list.counts.awaiting! >= 1);
  const all = (await app.inject({ method: "GET", url: "/api/admin/discovery?status=bogus&page=0", headers: { cookie } })).json() as { page: number };
  assert.equal(all.page, 1);

  assert.equal((await app.inject({ method: "POST", url: `/api/admin/discovery/${s.id}/dismiss`, headers: h, payload: "{}" })).json().code, "reason_required");
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/discovery/nope/dismiss`, headers: h, payload: JSON.stringify({ reason: "x" }) })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/discovery/${s.id}/dismiss`, headers: h, payload: JSON.stringify({ reason: "spam" }) })).json().signal.status, "dismissed");
  await observe(`${base}/op`);
  const restored = await app.inject({ method: "POST", url: `/api/admin/discovery/${s.id}/restore`, headers: h, payload: "{}" });
  assert.equal(restored.json().signal.status, "awaiting");
  assert.equal((await sql<{ status: string }[]>`SELECT status FROM discovery_signals WHERE id = ${s.id}`)[0]!.status, "promoted", "restored, then promoted by the gate");
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/discovery/${s.id}/restore`, headers: h, payload: "{}" })).statusCode, 404);

  const gate = (await app.inject({ method: "POST", url: "/api/admin/discovery/run", headers: h, payload: JSON.stringify({ gateOnly: true }) })).json();
  assert.ok("gate" in gate);
  const run = (await app.inject({ method: "POST", url: "/api/admin/discovery/run", headers: h, payload: "{}" })).json();
  assert.ok("feeds" in run && "gate" in run);
  assert.deepEqual((await app.inject({ method: "PUT", url: "/api/admin/discovery/settings", headers: h, payload: JSON.stringify({ feedCount: 99 }) })).json(), { feedCount: 3 });
  assert.deepEqual((await app.inject({ method: "PUT", url: "/api/admin/discovery/settings", headers: h, payload: JSON.stringify({ feedCount: 5 }) })).json(), { feedCount: 5 });
  const audits = await sql<{ action: string }[]>`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'discovery.%' OR action = 'settings.discovery'`;
  for (const a of ["discovery.dismiss", "discovery.restore", "discovery.gate", "discovery.run", "settings.discovery"]) assert.ok(audits.some((x) => x.action === a), a);
});
