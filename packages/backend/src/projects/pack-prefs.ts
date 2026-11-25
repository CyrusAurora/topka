// The user's last pack choice (master design 3.2 user_pack_prefs, handover §2.2): the wizard offers
// it back as 「上次你选了{包名}包」. One row per user; the latest write wins. Reading never fails on
// odd data: picks come back as plain strings in pick order.
import { sql, type Db, type Sql } from "../db.ts";

export interface PackPrefs {
  packId: string;
  picks: string[];
  at: Date;
}

export interface PackPrefsInput {
  packId: string;
  picks?: readonly string[];
}

function toPicks(value: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) for (const pick of value) if (typeof pick === "string" && !out.includes(pick)) out.push(pick);
  return out;
}

/** Saves the user's pack choice, replacing any previous one. */
export async function savePackPrefs(userId: string, input: PackPrefsInput, db: Sql = sql): Promise<PackPrefs> {
  const [row] = await db<{ pack_id: string; picks: unknown; at: Date }[]>`
    INSERT INTO user_pack_prefs (user_id, pack_id, picks, at)
    VALUES (${userId}, ${input.packId}, ${sql.json(toPicks(input.picks ?? []))}, now())
    ON CONFLICT (user_id) DO UPDATE SET pack_id = EXCLUDED.pack_id, picks = EXCLUDED.picks, at = now()
    RETURNING pack_id, picks, at`;
  return { packId: row!.pack_id, picks: toPicks(row!.picks), at: row!.at };
}

/** The user's last pack choice, or null when they have not chosen yet. */
export async function loadPackPrefs(userId: string, db: Db = sql): Promise<PackPrefs | null> {
  const [row] = await db<{ pack_id: string; picks: unknown; at: Date }[]>`
    SELECT pack_id, picks, at FROM user_pack_prefs WHERE user_id = ${userId}`;
  return row ? { packId: row.pack_id, picks: toPicks(row.picks), at: row.at } : null;
}
