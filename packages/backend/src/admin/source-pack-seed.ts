import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { sql, type Db, type Sql } from "../db.ts";
import { REPO_ROOT } from "../config.ts";
import { assertSupportedConfig } from "../sources/config-keys.ts";

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
}

export interface SourcePack {
  id: string;
  packId?: string;
  label?: string;
  sources: PackSource[];
}

export interface PackSeedResult {
  inserted: string[];
  merged: string[];
  unchanged: string[];
  ids: string[];
  packUpdated: boolean;
}

export function loadPack(name: string): SourcePack {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid pack name ${name}`);
  const filePath = path.join(REPO_ROOT, "database", "seeds", "packs", `${name}.json`);
  if (!existsSync(filePath)) throw new Error(`unknown pack ${name}`);
  return JSON.parse(readFileSync(filePath, "utf8")) as SourcePack;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

async function runSeed(pack: SourcePack, tx: Db): Promise<PackSeedResult> {
  const inserted: string[] = [];
  const merged: string[] = [];
  const unchanged: string[] = [];
  const ids: string[] = [];

  for (const s of pack.sources) assertSupportedConfig(s.kind, s.config);

  for (const s of pack.sources) {
    const byId = await tx<{ id: string; kind: string; config: Record<string, unknown>; tags: string[] | null }[]>`
      SELECT id, kind, config, tags FROM sources WHERE id = ${s.id}`;
    let existing = byId[0];
    if (!existing) {
      const byName = await tx<{ id: string; kind: string; config: Record<string, unknown>; tags: string[] | null }[]>`
        SELECT id, kind, config, tags FROM sources WHERE name = ${s.name} AND kind = ${s.kind}`;
      if (byName.length > 1) throw new Error(`ambiguous source name ${s.name}`);
      existing = byName[0];
    }

    if (!existing) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO sources (id, name, kind, config, tier, first_party, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, enabled, imported_from, next_fetch_at)
        VALUES (${s.id}, ${s.name}, ${s.kind}, ${tx.json(s.config as never)}, ${s.tier ?? "T2"}, ${s.first_party ?? false}, ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${s.tags ?? []}, ${s.site_fulltext ?? false}, ${s.syndicate_fulltext ?? false}, false, ${`pack:${pack.id}`}, now())
        RETURNING id`;
      const resolved = row?.id ?? s.id;
      inserted.push(resolved);
      ids.push(resolved);
    } else {
      const existingConfig = existing.config ?? {};
      const existingTags = existing.tags ?? [];
      const mergedConfig = { ...existingConfig, ...s.config };
      const mergedTags = [...new Set([...existingTags, ...(s.tags ?? [])])];
      const configSame = stableJson(mergedConfig) === stableJson(existingConfig);
      const tagsSame =
        stableJson([...existingTags].sort()) === stableJson([...mergedTags].sort());
      if (configSame && tagsSame) {
        unchanged.push(existing.id);
      } else {
        await tx`
          UPDATE sources SET config = ${tx.json(mergedConfig as never)}, tags = ${mergedTags}, updated_at = now()
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
    }));
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO source_packs (id, label, sources, updated_at)
      VALUES (${pack.packId}, ${pack.label ?? pack.packId}, ${tx.json(sourcesArray as never)}, now())
      ON CONFLICT (id) DO UPDATE SET sources = EXCLUDED.sources, updated_at = now()
      WHERE source_packs.sources IS DISTINCT FROM EXCLUDED.sources
      RETURNING id`;
    packUpdated = !!row;
  }

  return { inserted, merged, unchanged, ids, packUpdated };
}

export async function seedPack(pack: SourcePack, db: Db = sql): Promise<PackSeedResult> {
  if ("begin" in db) {
    return (db as Sql).begin(async (tx) => runSeed(pack, tx));
  }
  return runSeed(pack, db);
}
