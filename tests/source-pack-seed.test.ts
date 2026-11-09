import { readFileSync } from "node:fs";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { loadPack, seedPack, type SourcePack } from "@topka/backend/admin/source-pack-seed";
import { assertSupportedConfig } from "@topka/backend/sources/config-keys";
import { included } from "@topka/backend/sources/collect";

const T = tag();

test("embodied pack file", () => {
  const pack = loadPack("embodied");
  assert.equal(pack.sources.length, 18);
  const ids = pack.sources.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const names = pack.sources.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  for (const s of pack.sources) assertSupportedConfig(s.kind, s.config);
  for (const s of pack.sources) {
    if (s.config.feedUrl !== undefined) assert.match(String(s.config.feedUrl), /^https:\/\//);
  }
  const check = (value: unknown) => {
    if (typeof value === "string") assert.doesNotMatch(value, /token|secret|password|api[_-]?key/i);
    else if (Array.isArray(value)) value.forEach(check);
    else if (value && typeof value === "object") Object.values(value).forEach(check);
  };
  check(pack);
});

test("embodied pack media filters keep embodied titles and drop the rest", () => {
  const pack = loadPack("embodied");
  const byId = new Map(pack.sources.map((s) => [s.id, s]));
  const check = (id: string, keeps: string[], drops: string[]) => {
    const source = byId.get(id);
    assert.ok(source);
    for (const title of keeps) assert.ok(included({ title, excerpt: "" } as never, { config: source!.config } as never), `kept: ${title}`);
    for (const title of drops) assert.ok(!included({ title, excerpt: "" } as never, { config: source!.config } as never), `dropped: ${title}`);
  };
  check(
    "therobotreport",
    [
      "AGCO to deploy Agility Digit humanoid in Kansas factory",
      "Eka Robotics raises $150M to scale its vision-force-action model for robots",
      "Generative Bionics to launch Physical AI Data Factory in Italy",
      "Runway introduces Praxis-1 world action model for robotics",
    ],
    [
      "Gecko Robotics secures $300M contract with the U.S. Navy",
      "A guide to Day 1 of RoboBusiness 2026",
      "How to choose a BLDC motor for robotic arms and mobile robots",
      "OMRON to acquire OnLogic to address edge AI applications",
    ],
  );
  check(
    "rss:b1cb6e48a245d864e9b4daa06167dfc9",
    [
      "Toyota is betting $6.4 billion a year on humanoid robots and factory automation",
      "Nvidia open-sources Flora to make robot video labeling 125x cheaper than GPT-6 Astra",
    ],
    [
      "Meta plans up to $95 billion in stock sales to fund its AI buildout",
      "Mistral and Nvidia want to speed up industrial design with physics AI",
    ],
  );
  assert.equal(byId.get("techcrunch-robotics")!.config.includeIfMatches, undefined);
});

test("fresh rows are off, a second run changes nothing", async () => {
  const pack: SourcePack = {
    id: `fx-pack-${T}`,
    packId: `fx-pack-${T}`,
    label: "fx",
    sources: [
      { id: `fx-${T}-a`, name: `源A ${T}`, kind: "rss", config: { feedUrl: `https://example.com/${T}/a.xml` } },
      { id: `fx-${T}-b`, name: `源B ${T}`, kind: "rss", config: { feedUrl: `https://example.com/${T}/b.xml` } },
    ],
  };
  const first = await seedPack(pack);
  assert.equal(first.inserted.length, 2);
  const rows = await sql<{ id: string; enabled: boolean; imported_from: string }[]>`SELECT id, enabled, imported_from FROM sources WHERE id IN (${'fx-' + T + '-a'}, ${'fx-' + T + '-b'})`;
  for (const r of rows) {
    assert.equal(r.enabled, false);
    assert.equal(r.imported_from, `pack:${pack.id}`);
  }
  const second = await seedPack(pack);
  assert.equal(second.inserted.length, 0);
  assert.equal(second.merged.length, 0);
  assert.equal(second.unchanged.length, 2);
  assert.equal(second.packUpdated, false);
  const [cnt] = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM sources WHERE id LIKE ${'fx-' + T + '-%'}`;
  assert.equal(Number(cnt!.count), 2);
});

test("merges by name and keeps the switch", async () => {
  const oldId = `fx-${T}-old`;
  await sql`INSERT INTO sources (id, name, kind, config, tags, enabled, next_fetch_at)
    VALUES (${oldId}, ${'同名 ' + T}, 'rss', ${sql.json({ feedUrl: "https://example.com/old.xml", dailyCap: 3 })}, ARRAY['keep'], true, '2100-01-01')`;
  const pack: SourcePack = {
    id: `fx-pack-${T}-merge`,
    sources: [
      { id: `fx-${T}-new`, name: `同名 ${T}`, kind: "rss", config: { feedUrl: "https://example.com/new.xml", includeIfMatches: { title: "robot" } }, tags: ["embodied"] },
    ],
  };
  const result = await seedPack(pack);
  const [row] = await sql<{ id: string; config: { feedUrl: string; dailyCap: number; includeIfMatches: { title: string } }; tags: string[]; enabled: boolean }[]>`SELECT id, config, tags, enabled FROM sources WHERE name = ${'同名 ' + T} AND kind = 'rss'`;
  assert.equal(row!.id, oldId);
  assert.equal(row!.config.feedUrl, "https://example.com/new.xml");
  assert.equal(row!.config.dailyCap, 3);
  assert.equal(row!.config.includeIfMatches.title, "robot");
  assert.ok(row!.tags.includes("keep"));
  assert.ok(row!.tags.includes("embodied"));
  assert.equal(row!.enabled, true);
  const newRows = await sql`SELECT 1 FROM sources WHERE id = ${'fx-' + T + '-new'}`;
  assert.equal(newRows.length, 0);
  assert.deepEqual(result.merged, [oldId]);
  assert.deepEqual(result.ids, [oldId]);
});

test("ambiguous name throws", async () => {
  const name = `歧义 ${T}`;
  await sql`INSERT INTO sources (id, name, kind, config, next_fetch_at) VALUES (${'fx-' + T + '-a1'}, ${name}, 'rss', ${sql.json({ feedUrl: "https://example.com/a1.xml" })}, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, config, next_fetch_at) VALUES (${'fx-' + T + '-a2'}, ${name}, 'rss', ${sql.json({ feedUrl: "https://example.com/a2.xml" })}, '2100-01-01')`;
  const pack: SourcePack = {
    id: `fx-pack-${T}-amb`,
    sources: [{ id: `fx-${T}-unknown`, name, kind: "rss", config: { feedUrl: "https://example.com/new.xml" } }],
  };
  await assert.rejects(() => seedPack(pack), /ambiguous/);
});

test("a fresh install has every imported source off (0051)", async () => {
  // The test database is migrated fresh (no articles yet), like a new install: 0041's batch-1 rows
  // and 0040's pack placeholders must all be off.
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM sources WHERE enabled AND (imported_from = 'batch-1' OR 'curated-pack' = ANY (tags))`;
  assert.equal(row!.n, 0);
});

test("0051 leaves a database with articles alone", async () => {
  const sourceId = `fx-${T}-article-source`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at)
    VALUES (${sourceId}, ${'article source ' + T}, 'rss', 'T2', 'editorial', true, '2100-01-01')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${sourceId}, ${sourceId}, ${sourceId}, ${'https://example.org/' + sourceId}, ${'t'}, now(), now())`;
  const sqlText = readFileSync("database/migrations/0051_fresh_sources_off.sql", "utf8");
  const sentinel = new Error("rollback sentinel");
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
      const [row] = await tx<{ enabled: boolean }[]>`SELECT enabled FROM sources WHERE id = ${sourceId}`;
      assert.equal(row?.enabled, true);
      throw sentinel;
    });
  } catch (e) {
    assert.equal(e, sentinel);
  }
});

after(async () => {
  await sql`DELETE FROM articles WHERE source_id LIKE ${'fx-' + T + '-%'}`;
  await sql`DELETE FROM source_packs WHERE id LIKE ${'fx-pack-' + T + '%'}`;
  await sql`DELETE FROM sources WHERE id LIKE ${'fx-' + T + '-%'}`;
  await stopBoss();
  await closeDb();
});
