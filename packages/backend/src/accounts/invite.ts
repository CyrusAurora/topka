// Registration invitations: finite-use codes with an expiry (master design D6). Consumption is one
// guarded UPDATE, so two registrations racing on the last use cannot both win.
import { randomBytes } from "node:crypto";
import { sql, type Db } from "../db.ts";

export interface Invite {
  code: string;
  createdBy: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
  note: string | null;
}

export interface CreateInviteInput {
  /** An explicit code (an admin's readable one); otherwise a random one. */
  code?: string;
  createdBy?: string | null;
  maxUses?: number;
  /** How long the code stays valid; the default week keeps old codes from piling up. */
  expiresInDays?: number;
  note?: string | null;
}

export async function createInvite(input: CreateInviteInput, db: Db = sql): Promise<Invite> {
  const [row] = await db<Invite[]>`
    INSERT INTO invitations (code, created_by, max_uses, expires_at, note)
    VALUES (${input.code ?? randomBytes(9).toString("base64url")}, ${input.createdBy ?? null}, ${input.maxUses ?? 1},
            ${new Date(Date.now() + (input.expiresInDays ?? 7) * 86400_000)}, ${input.note ?? null})
    RETURNING code, created_by AS "createdBy", max_uses AS "maxUses", used_count AS "usedCount",
              expires_at AS "expiresAt", note`;
  return row!;
}

/**
 * Consumes one use of the invite if it exists, is unexpired and has a use left. The guard lives in
 * the UPDATE: the caller learns only whether this registration won the use.
 */
export async function consumeInvite(code: string, db: Db = sql): Promise<boolean> {
  const rows = await db<{ code: string }[]>`
    UPDATE invitations SET used_count = used_count + 1
    WHERE code = ${code} AND expires_at > now() AND used_count < max_uses
    RETURNING code`;
  return rows.length === 1;
}

/** Whether the invite would be consumable right now, without consuming it. */
export async function inviteConsumable(code: string, db: Db = sql): Promise<boolean> {
  const rows = await db<{ code: string }[]>`
    SELECT code FROM invitations WHERE code = ${code} AND expires_at > now() AND used_count < max_uses`;
  return rows.length === 1;
}
