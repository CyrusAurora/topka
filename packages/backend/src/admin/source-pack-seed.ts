// Source packs: the curated source lists behind the project wizard (database/seeds/packs/*.json).
// `seedPack` imports one pack (the `sources:seed` script); `seedAllPacks` imports every shipped pack on
// setup (scripts/seed.ts) so the wizard works on a fresh install. New rows always start switched off.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { sql, type Db, type Sql } from "../db.ts";
import { REPO_ROOT } from "../config.ts";
import { assertSupportedConfig } from "../sources/config-keys.ts";
import { normalizeRegions } from "../sources/regions.ts";

export interface PackSource {
  id: string;
  name: string;
  publisher?: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
  config: Record<string, unknown>;
  tier?: string;
  first_party?: boolean;
  participation_mode?: string;
  interval_minutes?: number;
  tags?: string[];
  site_fulltext?: boolean;
  syndicate_fulltext?: boolean;
  regions?: string[];
}

export interface SourcePack {
  id: string;
  packId?: string;
  label?: string;
  /** The pack's name in English readers' wizard. */
  labelEn?: string;
  sources: PackSource[];
}

export interface SeedPackOptions {
  /**
   * true (the `sources:seed` script): an existing row with the same id or name gets the pack's config,
   * tags and regions merged in. false (automatic setup): existing rows are bound as they are and never
   * changed, so a re-run of setup cannot rewrite an operator's sources.
   */
  mergeExisting?: boolean;
}

export interface PackSeedResult {
  inserted: string[];
  merged: string[];
  unchanged: string[];
  ids: string[];
  packUpdated: boolean;
}

export const PACKS_DIR = path.join(REPO_ROOT, "database", "seeds", "packs");

/** The shipped pack files' names (without .json), sorted. */
export function packFileNames(dir: string = PACKS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
}

/** A pack by its file name (`embodied`) or by the pack id the wizard shows (`embodied-ai`). */
export function loadPack(name: string, dir: string = PACKS_DIR): SourcePack {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid pack name ${name}`);
  const filePath = path.join(dir, `${name}.json`);
  if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, "utf8")) as SourcePack;
  for (const file of packFileNames(dir)) {
    const pack = JSON.parse(readFileSync(path.join(dir, `${file}.json`), "utf8")) as SourcePack;
    if (pack.packId === name) return pack;
  }
  throw new Error(`unknown pack ${name} (known: ${packFileNames(dir).join(", ")})`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

type SourceRow = { id: string; kind: string; config: Record<string, unknown>; tags: string[] | null; regions: string[] | null };

/**
 * Another row with this feed URL. An untouched batch-1 row (0041: never enabled or fetched, nothing
 * collected or bound) is deleted so the caller's row takes its place (its tags and regions are handed
 * back); an editorial row that is in use comes back as `inUse` for the caller to bind instead.
 */
export async function takeOverTwin(tx: Db, feedUrl: string): Promise<{ tags: string[]; regions: string[] | null; inUse: SourceRow | null }> {
  const gone = await tx<{ tags: string[]; regions: string[] }[]>`
    DELETE FROM sources t WHERE t.config->>'feedUrl' = ${feedUrl} AND t.imported_from = 'batch-1' AND NOT t.enabled AND t.last_fetch_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.source_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM fetch_runs f WHERE f.source_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM project_sources ps WHERE ps.source_id = t.id)
    RETURNING t.tags, t.regions`;
  const [inUse] = await tx<SourceRow[]>`
    SELECT id, kind, config, tags, regions FROM sources
    WHERE config->>'feedUrl' = ${feedUrl} AND participation_mode = 'editorial' AND config->'includeIfMatches' IS NULL
    ORDER BY enabled DESC, id LIMIT 1`;
  return { tags: [...new Set(gone.flatMap((g) => g.tags))], regions: gone[0]?.regions ?? null, inUse: inUse ?? null };
}

async function runSeed(pack: SourcePack, tx: Db, mergeExisting: boolean): Promise<PackSeedResult> {
  const inserted: string[] = [];
  const merged: string[] = [];
  const unchanged: string[] = [];
  const ids: string[] = [];

  for (const s of pack.sources) assertSupportedConfig(s.kind, s.config);

  for (const s of pack.sources) {
    const byId = await tx<{ id: string; kind: string; config: Record<string, unknown>; tags: string[] | null; regions: string[] | null }[]>`
      SELECT id, kind, config, tags, regions FROM sources WHERE id = ${s.id}`;
    let existing = byId[0];
    if (!existing) {
      const byName = await tx<{ id: string; kind: string; config: Record<string, unknown>; tags: string[] | null; regions: string[] | null }[]>`
        SELECT id, kind, config, tags, regions FROM sources WHERE name = ${s.name} AND kind = ${s.kind}`;
      if (byName.length > 1) throw new Error(`ambiguous source name ${s.name}`);
      existing = byName[0];
    }

    // Insert-only (setup): the same unfiltered feed already here under another id. An untouched batch-1
    // row gives way; one that is in use is bound as it is. A filtered entry (includeIfMatches) is a
    // deliberately separate row and never matched by feed.
    const feedUrl = typeof s.config.feedUrl === "string" ? s.config.feedUrl : null;
    let carriedTags: string[] = [];
    if (!existing && !mergeExisting && feedUrl && s.config.includeIfMatches === undefined) {
      const twin = await takeOverTwin(tx, feedUrl);
      carriedTags = twin.tags;
      if (twin.inUse) existing = twin.inUse;
    }

    const seedRegions = s.regions !== undefined ? normalizeRegions(s.regions) : null;
    if (existing && !mergeExisting) {
      unchanged.push(existing.id);
      ids.push(existing.id);
    } else if (!existing) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO sources (id, name, kind, config, tier, first_party, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, regions, enabled, imported_from, next_fetch_at)
        VALUES (${s.id}, ${s.name}, ${s.kind}, ${tx.json(s.config as never)}, ${s.tier ?? "T2"}, ${s.first_party ?? false}, ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${[...new Set([...(s.tags ?? []), ...carriedTags])]}, ${s.site_fulltext ?? false}, ${s.syndicate_fulltext ?? false}, ${seedRegions ?? ["global"]}, false, ${`pack:${pack.id}`}, now())
        RETURNING id`;
      const resolved = row?.id ?? s.id;
      inserted.push(resolved);
      ids.push(resolved);
    } else {
      const existingConfig = existing.config ?? {};
      const existingTags = existing.tags ?? [];
      const mergedConfig = { ...existingConfig, ...s.config };
      const mergedTags = [...new Set([...existingTags, ...(s.tags ?? [])])];
      const existingRegions = normalizeRegions(existing.regions);
      const mergedRegions = seedRegions === null ? existingRegions : seedRegions;
      const configSame = stableJson(mergedConfig) === stableJson(existingConfig);
      const tagsSame =
        stableJson([...existingTags].sort()) === stableJson([...mergedTags].sort());
      const regionsSame = stableJson([...existingRegions].sort()) === stableJson([...mergedRegions].sort());
      if (configSame && tagsSame && regionsSame) {
        unchanged.push(existing.id);
      } else {
        await tx`
          UPDATE sources SET config = ${tx.json(mergedConfig as never)}, tags = ${mergedTags}, regions = ${mergedRegions}, updated_at = now()
          WHERE id = ${existing.id}`;
        merged.push(existing.id);
      }
      ids.push(existing.id);
    }
  }

  let packUpdated = false;
  if (pack.packId) {
    const sourcesArray = ids.map((id, i) => ({
      id,
      name: pack.sources[i]!.name,
      publisher: pack.sources[i]!.publisher,
      regions: pack.sources[i]!.regions !== undefined ? normalizeRegions(pack.sources[i]!.regions) : ["global"],
    }));
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO source_packs (id, label, label_en, sources, updated_at)
      VALUES (${pack.packId}, ${pack.label ?? pack.packId}, ${pack.labelEn ?? null}, ${tx.json(sourcesArray as never)}, now())
      ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, label_en = EXCLUDED.label_en, sources = EXCLUDED.sources, updated_at = now()
      WHERE source_packs.sources IS DISTINCT FROM EXCLUDED.sources OR source_packs.label IS DISTINCT FROM EXCLUDED.label
         OR source_packs.label_en IS DISTINCT FROM EXCLUDED.label_en
      RETURNING id`;
    packUpdated = !!row;
  }

  return { inserted, merged, unchanged, ids, packUpdated };
}

export async function seedPack(pack: SourcePack, db: Db = sql, opts: SeedPackOptions = {}): Promise<PackSeedResult> {
  const merge = opts.mergeExisting ?? true;
  if ("begin" in db) {
    return (db as Sql).begin(async (tx) => runSeed(pack, tx, merge));
  }
  return runSeed(pack, db, merge);
}

export interface SeedAllResult {
  packs: Array<{ file: string; packId: string | null; inserted: number; bound: number }>;
  /** 0040's placeholder rows (kind external, tag curated-pack) no pack lists any more, deleted. */
  placeholdersRemoved: number;
}

/**
 * Setup: every shipped pack, insert-only (`mergeExisting: false`), then the 0040 placeholder rows that
 * no pack lists, no project binds and nothing was collected from are removed (they only ever stood in
 * for the real sources). Idempotent.
 */
export async function seedAllPacks(db: Sql = sql, dir: string = PACKS_DIR): Promise<SeedAllResult> {
  const packs: SeedAllResult["packs"] = [];
  for (const file of packFileNames(dir)) {
    const pack = loadPack(file, dir);
    const r = await seedPack(pack, db, { mergeExisting: false });
    packs.push({ file, packId: pack.packId ?? null, inserted: r.inserted.length, bound: r.ids.length });
  }
  const removed = await db<{ id: string }[]>`
    DELETE FROM sources s
    WHERE s.kind = 'external' AND 'curated-pack' = ANY (s.tags) AND NOT s.enabled
      AND NOT EXISTS (SELECT 1 FROM source_packs p, jsonb_array_elements(p.sources) e WHERE e->>'id' = s.id)
      AND NOT EXISTS (SELECT 1 FROM project_sources ps WHERE ps.source_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.source_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM fetch_runs f WHERE f.source_id = s.id)
    RETURNING s.id`;
  return { packs, placeholdersRemoved: removed.length };
}
