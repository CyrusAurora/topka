// Switching sources on and off from the command line (scripts/sources.ts). Each switch goes through
// updateSource, like the admin page: health, the next fetch and the audit log follow the same rules.
import { sql, type Db } from "../db.ts";
import { updateSource } from "./sources.ts";

export interface SourceLine {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  health: string;
  last_ok_at: Date | null;
  articles: number;
}

export async function listSourceLines(filter: { enabled?: boolean; q?: string } = {}, db: Db = sql): Promise<SourceLine[]> {
  const q = filter.q ? `%${filter.q}%` : null;
  return db<SourceLine[]>`
    SELECT s.id, s.name, s.kind, s.enabled, s.health, s.last_ok_at,
           (SELECT count(*)::int FROM articles a WHERE a.source_id = s.id) AS articles
    FROM sources s
    WHERE (${filter.enabled ?? null}::boolean IS NULL OR s.enabled = ${filter.enabled ?? null})
      AND (${q}::text IS NULL OR s.id ILIKE ${q} OR s.name ILIKE ${q} OR s.config->>'feedUrl' ILIKE ${q})
    ORDER BY s.enabled DESC, s.name`;
}

export interface SwitchResult {
  changed: string[];
  unchanged: string[];
  missing: string[];
}

/** Switches the given sources (ids, or exact names) on or off; ids that match nothing are reported. */
export async function switchSources(keys: readonly string[], enabled: boolean, actor: string, reason: string | null): Promise<SwitchResult> {
  const result: SwitchResult = { changed: [], unchanged: [], missing: [] };
  for (const key of [...new Set(keys)]) {
    const rows = await sql<{ id: string; enabled: boolean; updated_at: Date }[]>`
      SELECT id, enabled, updated_at FROM sources WHERE id = ${key} OR name = ${key}`;
    if (rows.length === 0) result.missing.push(key);
    for (const row of rows) {
      if (row.enabled === enabled) {
        result.unchanged.push(row.id);
        continue;
      }
      await updateSource(row.id, { patch: { enabled }, version: new Date(row.updated_at).toISOString(), reason: reason ?? undefined }, actor);
      result.changed.push(row.id);
    }
  }
  return result;
}

/** Every source except the given ones off (the given ones on): a fixed short list in one step. */
export async function onlySources(keys: readonly string[], actor: string, reason: string | null): Promise<SwitchResult & { offed: string[] }> {
  const on = await switchSources(keys, true, actor, reason);
  const keep = new Set([...on.changed, ...on.unchanged]);
  const others = (await sql<{ id: string }[]>`SELECT id FROM sources WHERE enabled`).map((r) => r.id).filter((id) => !keep.has(id));
  const off = await switchSources(others, false, actor, reason);
  return { ...on, offed: off.changed };
}
