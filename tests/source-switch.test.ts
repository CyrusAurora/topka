// A source's switch covers collection and every model step: content of a switched-off source is not
// queued for analysis, grouping or extraction, a job queued before the switch leaves it untouched,
// the safety net skips it, reports and translations do not read it and an ingest push is refused.
// Switching the source back on hands the waiting content over again. The sources script switches
// sources the way the admin page does.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { config } from "@topka/backend/config";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { processArticle, queueProcessing, sweepUnprocessed } from "@topka/backend/jobs/content";
import { stopBoss } from "@topka/backend/jobs/queue";
import { articleSourceEnabled } from "@topka/backend/sources/enabled";
import { ingestItems } from "@topka/backend/ingest/items";
import { listSourceLines, switchSources } from "@topka/backend/admin/source-switch";

const run = promisify(execFile);
const T = tag();
const ON = `test-switch-on-${T}`;
const OFF = `test-switch-off-${T}`;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES
            (${ON}, ${`Switch on ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01'),
            (${OFF}, ${`Switch off ${T}`}, 'rss', 'T1', 'editorial', false, '2100-01-01')`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

async function article(sourceId: string, suffix: string) {
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/switch-${T}-${sourceId === ON ? "on" : "off"}-${suffix}`, title: `Switch ${suffix} ${T}`, bodyText: "Body.", bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  // Old enough for the safety net.
  await sql`UPDATE articles SET created_at = now() - interval '10 minutes', processing_queued_at = NULL WHERE id = ${articleId}`;
  return articleId;
}
const queuedAt = async (id: string) =>
  (await sql<{ processing_queued_at: Date | null; processing_state: string }[]>`SELECT processing_queued_at, processing_state FROM articles WHERE id = ${id}`)[0]!;
const jobs = async (id: string) => (await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE singleton_key = ${id}`).map((j) => j.name);

test("a switched-off source's article is not queued for any processing; a switched-on one is", async () => {
  const on = await article(ON, "a");
  const off = await article(OFF, "a");
  assert.equal(await articleSourceEnabled(on), true);
  assert.equal(await articleSourceEnabled(off), false);
  assert.notEqual(await queueProcessing(on), null);
  assert.deepEqual(await jobs(on), ["content.analyze"]);
  for (const step of [undefined, "analyze", "extract"] as const) assert.equal(await queueProcessing(off, step ? { step } : {}), null, String(step));
  assert.deepEqual(await jobs(off), []);
  assert.equal((await queuedAt(off)).processing_queued_at, null, "not marked queued, so the safety net can hand it over later");
});

test("a job queued before the switch leaves the article untouched and asks no model", async () => {
  const off = await article(OFF, "b");
  assert.deepEqual(await processArticle(off), { state: "source-off" });
  assert.equal((await queuedAt(off)).processing_state, "new");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${off}`).length, 0);
});

test("with model calls off nothing is queued for a model; extraction (no model) still is", async () => {
  const on = await article(ON, "c");
  config.modelCallsEnabled = false;
  try {
    assert.equal(await queueProcessing(on, { step: "analyze" }), null);
    assert.deepEqual(await processArticle(on), { state: "models-off" });
    assert.notEqual(await queueProcessing(on, { step: "extract" }), null);
  } finally {
    config.modelCallsEnabled = true;
  }
  assert.equal((await queuedAt(on)).processing_state, "new");
});

test("the safety net skips switched-off sources and picks their content up once switched on", async () => {
  const off = await article(OFF, "d");
  await sweepUnprocessed();
  assert.deepEqual(await jobs(off), []);
  await sql`UPDATE sources SET enabled = true WHERE id = ${OFF}`;
  try {
    await sweepUnprocessed();
    assert.deepEqual(await jobs(off), ["content.analyze"]);
  } finally {
    await sql`UPDATE sources SET enabled = false WHERE id = ${OFF}`;
  }
});

test("a switched-off external source takes no ingest push", async () => {
  const id = `test-switch-ext-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled) VALUES (${id}, 'ext', 'external', 'T2', 'isolated', false)`;
  await assert.rejects(ingestItems({ sourceId: id, items: [{ title: "x", url: `https://example.com/ext-${T}` }] }), (error: { status?: number }) => error.status === 409);
  assert.equal((await sql`SELECT 1 FROM articles WHERE source_id = ${id}`).length, 0);
});

test("switching by id or exact name goes through the admin rules", async () => {
  const r = await switchSources([ON, `Switch off ${T}`, `nope-${T}`], true, "tester", "test");
  assert.deepEqual([r.changed, r.unchanged, r.missing], [[OFF], [ON], [`nope-${T}`]]);
  const [s] = await sql<{ health: string }[]>`SELECT health FROM sources WHERE id = ${OFF}`;
  assert.notEqual(s!.health, "paused");
  await switchSources([OFF], false, "tester", "test");
  const [p] = await sql<{ health: string; enabled: boolean }[]>`SELECT health, enabled FROM sources WHERE id = ${OFF}`;
  assert.deepEqual(p, { health: "paused", enabled: false });
  const lines = await listSourceLines({ q: T });
  assert.deepEqual(lines.map((l) => [l.id, l.enabled]).filter(([id]) => id === ON || id === OFF), [[ON, true], [OFF, false]]);
  assert.ok(lines.find((l) => l.id === ON)!.articles >= 1);
  const audited = await sql`SELECT 1 FROM audit_log WHERE subject = ${`source:${OFF}`} AND action = 'source.update'`;
  assert.equal(audited.length, 2);
});

test("the sources script lists and switches", async () => {
  const { stdout } = await run(process.execPath, ["scripts/sources.ts", "toggle", "--on", "--id", OFF]);
  assert.match(stdout, /已打开 1 个/);
  const listed = await run(process.execPath, ["scripts/sources.ts", "list", "--enabled", "--q", T]);
  assert.match(listed.stdout, new RegExp(`on \\t${OFF}`));
  await run(process.execPath, ["scripts/sources.ts", "toggle", "--off", "--id", OFF]);
  await assert.rejects(run(process.execPath, ["scripts/sources.ts", "toggle", "--id", OFF]), (e: { code?: number }) => e.code === 2);
  await assert.rejects(run(process.execPath, ["scripts/sources.ts", "toggle", "--off", "--id", `nope-${T}`]), (e: { code?: number }) => e.code === 1);
});
