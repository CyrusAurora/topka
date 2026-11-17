// Row counts and a content checksum per table, to prove a restored database holds what the source
// held (restore drill) or to see what a migration touched. The checksum is the md5 of the sorted
// md5 of every row's text form: independent of physical order, sensitive to any value.
import type { Db } from "../db.ts";

export type Fingerprint = Record<string, { rows: number; checksum: string }>;

export async function fingerprint(db: Db, opts: { tables?: string[] } = {}): Promise<Fingerprint> {
  const tables = opts.tables ?? (await db<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`).map((t) => t.name);
  const out: Fingerprint = {};
  for (const table of tables) {
    const [r] = await db<{ rows: number; checksum: string | null }[]>`
      SELECT count(*)::int AS rows, md5(string_agg(h, '' ORDER BY h)) AS checksum
      FROM (SELECT md5(t::text) AS h FROM ${db(table)} t) x`;
    out[table] = { rows: r.rows, checksum: r.checksum ?? "" };
  }
  return out;
}

/** Tables that differ between two fingerprints (missing on one side, other count or checksum). */
export function compareFingerprints(a: Fingerprint, b: Fingerprint): string[] {
  const diffs: string[] = [];
  for (const t of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!a[t]) diffs.push(`${t}: only in the second`);
    else if (!b[t]) diffs.push(`${t}: only in the first`);
    else if (a[t].rows !== b[t].rows) diffs.push(`${t}: ${a[t].rows} rows vs ${b[t].rows}`);
    else if (a[t].checksum !== b[t].checksum) diffs.push(`${t}: same ${a[t].rows} rows, different content`);
  }
  return diffs;
}
