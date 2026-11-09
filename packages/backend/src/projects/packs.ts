// Reading the curated pack catalog (master design 3.2 source_packs): the four seeded packs with
// their static source lists, in pack-id order. The wizard's second step renders exactly this list
// and makes no further request. Availability: a seeded pack still lists
// placeholder source ids until its real sources are imported (npm run sources:seed -- --pack …);
// a pack is available as soon as at least one of its ids exists in `sources` as an editorial
// source — the shape project creation requires.
import { sql, type Db } from "../db.ts";
import { normalizeRegions, sourceMatchesRegionFilter } from "../sources/regions.ts";

export interface PackSource {
  id: string;
  name: string;
  publisher: string | null;
  regions: string[];
}

export interface SourcePack {
  id: string;
  label: string;
  sources: PackSource[];
  available: boolean;
}

function toSources(value: unknown): PackSource[] {
  if (!Array.isArray(value)) return [];
  const out: PackSource[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" && typeof (entry as { name?: unknown }).name === "string") {
      const source = entry as { id: string; name: string; publisher?: unknown; regions?: unknown };
      out.push({ id: source.id, name: source.name, publisher: typeof source.publisher === "string" ? source.publisher : null, regions: normalizeRegions(source.regions) });
    }
  }
  return out;
}

export async function listSourcePacks(db: Db = sql, opts?: { regions?: readonly string[] }): Promise<SourcePack[]> {
  const rows = await db<{ id: string; label: string; sources: unknown }[]>`
    SELECT id, label, sources FROM source_packs ORDER BY id`;
  const packs = rows.map((row) => ({ id: row.id, label: row.label, sources: toSources(row.sources) }));
  // Only editorial sources can be bound to a project (the create path's assertSourcesExist accepts
  // any id, but a placeholder row is `kind = 'external'` + `participation_mode = 'isolated'`):
  // available means at least one listed id is a real, bindable source row.
  // Live `sources.regions` is the geography source of truth; pack JSON regions are a fallback for
  // ids not yet imported (treated as ["global"] by toSources / normalizeRegions).
  const allIds = new Set(packs.flatMap((pack) => pack.sources.map((source) => source.id)));
  const existing = allIds.size ? await db<{ id: string; regions: string[] | null }[]>`
    SELECT id, regions FROM sources WHERE id IN ${db([...allIds])} AND participation_mode = 'editorial'` : [];
  const live = new Map(existing.map((row) => [row.id, normalizeRegions(row.regions)] as const));
  const withLiveRegions = packs.map((pack) => ({
    ...pack,
    sources: pack.sources.map((source) => ({
      ...source,
      regions: live.get(source.id) ?? source.regions,
    })),
    available: pack.sources.some((source) => live.has(source.id)),
  }));
  const filter = (opts?.regions ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (filter.length === 0) return withLiveRegions;
  // Region is a discovery filter inside the pack: packs stay listed, their source list shrinks.
  // An emptied pack keeps listed-but-empty sources and reads unavailable (no editorial row left).
  return withLiveRegions.map((pack) => {
    const sources = pack.sources.filter((source) => sourceMatchesRegionFilter(source.regions, filter));
    return { ...pack, sources, available: sources.some((source) => live.has(source.id)) };
  });
}
