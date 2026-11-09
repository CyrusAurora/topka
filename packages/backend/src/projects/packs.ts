// Reading the curated pack catalog (master design 3.2 source_packs): the four seeded packs with
// their static source lists, in pack-id order. The wizard's second step renders exactly this list
// and makes no further request. Availability: a seeded pack still lists
// placeholder source ids until its real sources are imported (npm run sources:seed -- --pack …);
// a pack is available as soon as at least one of its ids exists in `sources` as an editorial
// source — the shape project creation requires.
import { sql, type Db } from "../db.ts";

export interface PackSource {
  id: string;
  name: string;
  publisher: string | null;
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
      const source = entry as { id: string; name: string; publisher?: unknown };
      out.push({ id: source.id, name: source.name, publisher: typeof source.publisher === "string" ? source.publisher : null });
    }
  }
  return out;
}

export async function listSourcePacks(db: Db = sql): Promise<SourcePack[]> {
  const rows = await db<{ id: string; label: string; sources: unknown }[]>`
    SELECT id, label, sources FROM source_packs ORDER BY id`;
  const packs = rows.map((row) => ({ id: row.id, label: row.label, sources: toSources(row.sources) }));
  // Only editorial sources can be bound to a project (the create path's assertSourcesExist accepts
  // any id, but a placeholder row is `kind = 'external'` + `participation_mode = 'isolated'`):
  // available means at least one listed id is a real, bindable source row.
  const allIds = new Set(packs.flatMap((pack) => pack.sources.map((source) => source.id)));
  const existing = allIds.size ? await db<{ id: string }[]>`
    SELECT id FROM sources WHERE id IN ${db([...allIds])} AND participation_mode = 'editorial'` : [];
  const live = new Set(existing.map((row) => row.id));
  return packs.map((pack) => ({ ...pack, available: pack.sources.some((source) => live.has(source.id)) }));
}
