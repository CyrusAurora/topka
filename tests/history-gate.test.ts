// History no reader view shows (backfill published more than 24 hours ago) is analysed last: in the
// evening window only, with a reserve of the day's calls kept for fresh items; or skipped outright.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.MODEL_CALLS_ENABLED = "true";
process.env.HISTORY_ANALYSIS_TZ = "Asia/Shanghai";
process.env.HISTORY_ANALYSIS_WINDOW = "20-8";
// The 72-hour stale rule has its own test below; the history fixtures sit around that age.
process.env.STALE_ANALYSIS_HOURS = "0";
// No chain keys here: the gate must fall back to the plain OpenRouter budget, and no test may reach a provider.
delete process.env.OPENCODE_API_KEY;
delete process.env.AGNES_API_KEY;
delete process.env.LLM_FREE_MODELS;
const T = tag();
const SOURCE = `test-history-gate-${T}`;
const gate = await import("@topka/backend/editorial/history-gate");
const { processArticle } = await import("@topka/backend/jobs/content");
const { upsertMaterial } = await import("@topka/backend/content/materials");
const { BudgetExceededError } = await import("@topka/backend/providers/receipts");
const { benchProvider, benchRoute, resetFreeChain } = await import("@topka/backend/providers/free-chain");
const { closeDb, sql } = await import("@topka/backend/db");
const { stopBoss } = await import("@topka/backend/jobs/queue");

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'History gate', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

// Yesterday's clock times (UTC date), so the fixtures made relative to the real now stay history at the mocked noon.
const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const noon = new Date(`${day}T04:00:00Z`); // 12:00 UTC+8
const evening = new Date(`${day}T13:00:00Z`); // 21:00 UTC+8
const dawn = new Date(`${day}T23:30:00Z`); // 07:30 UTC+8

test("the window runs from 20:00 to 08:00 UTC+8; outside it, history waits for 20:00", () => {
  assert.equal(gate.inHistoryWindow(noon), false);
  assert.equal(gate.inHistoryWindow(evening), true);
  assert.equal(gate.inHistoryWindow(dawn), true);
  assert.equal(gate.inHistoryWindow(new Date("2026-10-22T00:00:00Z")), false, "08:00 UTC+8: OpenRouter's day has reset, fresh items first");
  assert.equal(gate.secondsToHistoryWindow(noon), 8 * 3600);
});

test("only backfill published more than 24 hours ago is unread history", () => {
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
  assert.equal(gate.isUnreadHistory({ backfill: true, published_at: ago(30), discovered_at: now }, now), true);
  assert.equal(gate.isUnreadHistory({ backfill: true, published_at: ago(2), discovered_at: now }, now), false, "today's first import is read");
  assert.equal(gate.isUnreadHistory({ backfill: false, published_at: ago(30), discovered_at: now }, now), false, "live items are never deferred");
});

async function history(n: string, hoursAgo: number) {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/history-${T}/${n}`, title: `History ${n} ${T}`, bodyText: "Body text. ".repeat(10),
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - hoursAgo * 3_600_000),
  } as never);
  await sql`UPDATE articles SET backfill = true, backfill_reason = 'first-import' WHERE id = ${articleId}`;
  return articleId;
}

test("at noon, old history waits (a budget wait, no model call); with too few calls left it waits in the evening too", async (t) => {
  const id = await history("old", 96);
  t.mock.timers.enable({ apis: ["Date"], now: noon });
  await assert.rejects(processArticle(id), (e: unknown) => e instanceof gate.HistoryDeferredError && e instanceof BudgetExceededError && (e as InstanceType<typeof BudgetExceededError>).retryAfterSeconds === 8 * 3600);
  t.mock.timers.reset();
  // Evening, but the day's budget is nearly spent: the reserve stays for fresh items.
  const [b] = await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = 'llm'`;
  await sql`UPDATE budgets SET per_day = 100 WHERE service = 'llm'`;
  try {
    process.env.HISTORY_ANALYSIS_RESERVE = "150";
    await assert.rejects(gate.assertHistoryMayRun(evening), (e: unknown) => e instanceof gate.HistoryDeferredError && /kept for fresh items/.test((e as Error).message));
    await sql`UPDATE budgets SET per_day = 100000 WHERE service = 'llm'`;
    await gate.assertHistoryMayRun(evening);
  } finally {
    await sql`UPDATE budgets SET per_day = ${b!.per_day} WHERE service = 'llm'`;
    delete process.env.HISTORY_ANALYSIS_RESERVE;
  }
});

test("in the evening, Agnes capacity lets history run even when OpenRouter is nearly spent", async () => {
  const [llm] = await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = 'llm'`;
  const [agnes] = await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = 'agnes'`;
  process.env.AGNES_API_KEY = "test-agnes";
  process.env.HISTORY_ANALYSIS_RESERVE = "150";
  resetFreeChain();
  try {
    // OpenRouter's own budget is nearly spent; Agnes carries the chain.
    await sql`UPDATE budgets SET per_day = 100 WHERE service = 'llm'`;
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES ('agnes', 30, 900, 100000, 'history gate test')
      ON CONFLICT (service) DO UPDATE SET per_day = 100000`;
    await gate.assertHistoryMayRun(evening);
    assert.ok((await gate.callsLeftToday())! > 150, "Agnes's budget is what history counts on");
    benchRoute("agnes", "agnes-3.0-flash", 60, "HTTP 429");
    await gate.assertHistoryMayRun(evening); // a minute's rate limit is not a day without capacity
    benchProvider("agnes", 3600, "test");
    await assert.rejects(gate.assertHistoryMayRun(evening), (e: unknown) => e instanceof gate.HistoryDeferredError);
  } finally {
    delete process.env.AGNES_API_KEY;
    delete process.env.HISTORY_ANALYSIS_RESERVE;
    resetFreeChain();
    await sql`UPDATE budgets SET per_day = ${llm!.per_day} WHERE service = 'llm'`;
    if (agnes) await sql`UPDATE budgets SET per_day = ${agnes.per_day} WHERE service = 'agnes'`;
    else await sql`DELETE FROM budgets WHERE service = 'agnes'`;
  }
});

test("HISTORY_ANALYSIS=skip marks old history skipped without a model call", async () => {
  const id = await history("skip", 72);
  process.env.HISTORY_ANALYSIS = "skip";
  try {
    assert.deepEqual(await processArticle(id), { state: "history-skipped" });
  } finally {
    delete process.env.HISTORY_ANALYSIS;
  }
  const [row] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${id}`;
  assert.equal(row!.processing_state, "skipped");
  const receipts = await sql`SELECT 1 FROM receipts WHERE subject LIKE ${`article:${id}%`}`;
  assert.equal(receipts.length, 0);
});

test("anything published more than STALE_ANALYSIS_HOURS ago is skipped without a model call, history or not", async () => {
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
  process.env.STALE_ANALYSIS_HOURS = "72";
  try {
    assert.equal(gate.isStale({ published_at: ago(73), discovered_at: now }, now), true);
    assert.equal(gate.isStale({ published_at: ago(71), discovered_at: now }, now), false);
    assert.equal(gate.isStale({ published_at: null, discovered_at: ago(80) }, now), true, "no publication time: the discovery time");
    const { articleId: live } = await upsertMaterial({
      sourceId: SOURCE, url: `https://example.org/stale-${T}`, title: `Stale ${T}`, bodyText: "Body text. ".repeat(10),
      bodyStatus: "ok", via: "fetch", publishedAt: ago(100),
    } as never);
    assert.deepEqual(await processArticle(live), { state: "stale-skipped" });
    const [row] = await sql<{ processing_state: string; processing_error: string }[]>`SELECT processing_state, processing_error FROM articles WHERE id = ${live}`;
    assert.deepEqual([row!.processing_state, row!.processing_error.startsWith("stale:")], ["skipped", true]);
    assert.equal((await sql`SELECT 1 FROM receipts WHERE subject LIKE ${`article:${live}%`}`).length, 0);
    process.env.STALE_ANALYSIS_HOURS = "0";
    assert.equal(gate.isStale({ published_at: ago(1000), discovered_at: now }, now), false, "0 turns it off");
  } finally {
    process.env.STALE_ANALYSIS_HOURS = "0";
  }
});

test("the sweep expires the unreachable backlog in bulk, without waiting for each item's turn", async () => {
  const { expireUnreachable } = await import("@topka/backend/jobs/content");
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
  const make = async (name: string, hours: number) => (await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/expire-${name}-${T}`, title: `Expire ${name} ${T}`, bodyText: "Body text. ".repeat(10),
    bodyStatus: "ok", via: "fetch", publishedAt: ago(hours),
  } as never)).articleId;
  const stale = await make("stale", 100), fresh = await make("fresh", 1);
  const old = await history("expire-history", 30);
  const state = async (id: string) => (await sql<{ processing_state: string; processing_error: string | null }[]>`SELECT processing_state, processing_error FROM articles WHERE id = ${id}`)[0]!;
  assert.equal(await expireUnreachable(), 0, "both rules off: nothing expires");
  process.env.STALE_ANALYSIS_HOURS = "72";
  process.env.HISTORY_ANALYSIS = "skip";
  try {
    assert.ok(await expireUnreachable() >= 2);
    assert.equal((await state(stale)).processing_state, "skipped");
    assert.match((await state(stale)).processing_error!, /^stale:/);
    assert.deepEqual({ ...(await state(old)) }, { processing_state: "skipped", processing_error: "history: not analysed (HISTORY_ANALYSIS=skip)" });
    assert.equal((await state(fresh)).processing_state, "new");
    // A job still queued for an expired item re-skips it for free.
    assert.deepEqual(await processArticle(stale), { state: "stale-skipped" });
    assert.equal((await sql`SELECT 1 FROM receipts WHERE subject LIKE ${`article:${stale}%`}`).length, 0);
  } finally {
    process.env.STALE_ANALYSIS_HOURS = "0";
    delete process.env.HISTORY_ANALYSIS;
  }
});
