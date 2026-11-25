// Seeds a fresh site from the industry pack: the demo sources (industry/sources.json, only the ones not
// there yet, so admin edits are never undone) and the project wizard's source packs
// (database/seeds/packs/*.json, insert-only).
// Sources are imported switched off (existing rows are never touched, ON CONFLICT DO NOTHING stays).
// A demo source whose feed is already in the database as an untouched batch-1 row (0041: never enabled,
// never fetched, nothing collected or bound) takes that row's place, so a fresh install has each feed once.
// Re-runnable:  node --env-file=.env scripts/seed.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@topka/backend/config";
import { closeDb, sql } from "@topka/backend/db";
import { assertSupportedConfig } from "@topka/backend/sources/config-keys";
import { seedAllPacks, takeOverTwin } from "@topka/backend/admin/source-pack-seed";

interface SeedSource {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
  config: Record<string, unknown>;
  tier?: string;
  first_party?: boolean;
  owner_entity_id?: string | null;
  participation_mode?: string;
  interval_minutes?: number;
  tags?: string[];
  site_fulltext?: boolean;
  enabled?: boolean;
}

const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: SeedSource[] };
let added = 0;
let replaced = 0;
for (const s of sources) {
  assertSupportedConfig(s.kind, s.config);
  const feedUrl = typeof s.config.feedUrl === "string" ? s.config.feedUrl : null;
  const inserted = await sql.begin(async (tx) => {
    const [exists] = await tx`SELECT 1 FROM sources WHERE id = ${s.id}`;
    if (exists) return [];
    // The same feed as an untouched batch-1 row: that row gives way (its regions and tags carry over).
    const twin = feedUrl ? await takeOverTwin(tx, feedUrl) : { tags: [], regions: null, inUse: null };
    if (twin.regions) replaced += 1;
    const regions = twin.regions ?? ["global"];
    const tags = [...new Set([...(s.tags ?? []), ...twin.tags])];
    return tx`
      INSERT INTO sources (id, name, kind, config, tier, first_party, owner_entity_id, participation_mode, interval_minutes, tags, site_fulltext, regions, enabled, next_fetch_at)
      VALUES (${s.id}, ${s.name}, ${s.kind}, ${sql.json(s.config as never)}, ${s.tier ?? "T2"}, ${s.first_party ?? false}, ${s.owner_entity_id ?? null},
              ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${tags}, ${s.site_fulltext ?? false},
              ${regions}, ${s.enabled ?? false}, now())
      ON CONFLICT (id) DO NOTHING RETURNING id`;
  });
  added += inserted.length;
}
const packs = await seedAllPacks(sql);
const packAdded = packs.packs.reduce((n, p) => n + p.inserted, 0);
const [{ total, on }] = await sql<{ total: number; on: number }[]>`
  SELECT count(*)::int AS total, count(*) FILTER (WHERE enabled)::int AS on FROM sources WHERE kind <> 'external'`;
console.log(`sources: ${added + packAdded} added (${added} from industry/sources.json, ${packAdded} from the project packs${replaced ? `, ${replaced} duplicate feeds merged` : ""}); ${total} in the database, ${on} switched on`);
console.log(`packs: ${packs.packs.map((p) => `${p.packId ?? p.file} ${p.bound}`).join(", ")}${packs.placeholdersRemoved ? `; ${packs.placeholdersRemoved} placeholder rows removed` : ""}`);
await closeDb();
