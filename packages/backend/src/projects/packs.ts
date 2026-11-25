// Reading the curated pack catalog (master design 3.2 source_packs): the seeded packs with their
// static source lists, in pack-id order. The wizard's second step renders exactly this list and makes
// no further request. Setup (scripts/seed.ts) imports every shipped pack, so a fresh install has them
// all; a pack is available as soon as at least one of its ids exists in `sources` as an editorial
// source — the shape project creation requires. An unavailable pack says why (`reason`), and the
// wizard shows the fix (`npm run sources:seed -- --pack <id>`).
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
  /** The pack's English name (null: none recorded; the wizard then shows `label`). */
  labelEn: string | null;
  sources: PackSource[];
  available: boolean;
  /** Why not available: its sources are not imported here, or the region filter left none. */
  reason: "not-imported" | "region-empty" | null;
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
  const rows = await db<{ id: string; label: string; label_en: string | null; sources: unknown }[]>`
    SELECT id, label, label_en, sources FROM source_packs ORDER BY id`;
  const packs = rows.map((row) => ({ id: row.id, label: row.label, labelEn: row.label_en, sources: toSources(row.sources) }));
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
  })).map((pack) => ({ ...pack, reason: pack.available ? null : ("not-imported" as const) }));
  const filter = (opts?.regions ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (filter.length === 0) return withLiveRegions;
  // Region is a discovery filter inside the pack: packs stay listed, their source list shrinks.
  // An emptied pack keeps listed-but-empty sources and reads unavailable (no editorial row left).
  return withLiveRegions.map((pack) => {
    const sources = pack.sources.filter((source) => sourceMatchesRegionFilter(source.regions, filter));
    const available = sources.some((source) => live.has(source.id));
    return { ...pack, sources, available, reason: available ? null : pack.reason ?? ("region-empty" as const) };
  });
}
