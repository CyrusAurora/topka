// The registration use case (master design D6/J1, final decision 2026-10-27: open registration + BYOK).
// An email and a password become an active user with a live session. REGISTRATION_MODE picks the door:
// "open" (the default, for self-hosting too) needs no invite; "invite" keeps the invite-code gate.
// Every refusal is typed, and a refused registration consumes neither the invite nor the address.
import { sql, type Sql } from "../db.ts";
import { newUuid } from "../lib/ids.ts";
import { consumeInvite, inviteConsumable } from "./invite.ts";
import { hashPassword, passwordTooWeak } from "./password.ts";
import { createSession, type SessionUser } from "./session.ts";

export type RegisterReason = "invite-invalid" | "email-taken" | "weak-password" | "invalid-email";

export class RegisterRejected extends Error {
  readonly reason: RegisterReason;
  constructor(reason: RegisterReason) {
    super(reason);
    this.reason = reason;
  }
}

export type RegistrationMode = "open" | "invite";

/** REGISTRATION_MODE, read at call time: unset or "open" is open; "invite" (or any other value, so a
 * typo fails closed) keeps the invite gate. */
export function registrationMode(env: NodeJS.ProcessEnv = process.env): RegistrationMode {
  const v = (env.REGISTRATION_MODE ?? "").trim().toLowerCase();
  return v === "" || v === "open" ? "open" : "invite";
}

/** A plain address shape; deliverability is the email-verification step's business, not ours. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RegisterInput {
  /** The invite code; ignored when registration is open. */
  code: string;
  email: string;
  password: string;
  userAgent?: string | null;
  ip?: string | null;
}

export interface RegisterResult {
  token: string;
  user: SessionUser;
}

/** The address as stored (trimmed, lower case), or null when it does not look like one. */
export function normalizeEmail(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(address) || address.length > 254) return null;
  const [local, domain] = address.split("@") as [string, string];
  if (local.length > 64 || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..") || !/^[a-z0-9.-]+$/.test(domain)) return null;
  return address;
}

export async function registerWithInvite(input: RegisterInput, db: Sql = sql, mode: RegistrationMode = registrationMode()): Promise<RegisterResult> {
  const address = normalizeEmail(input.email);
  if (!address) throw new RegisterRejected("invalid-email");
  if (passwordTooWeak(input.password) || input.password.length > 200 || input.password.trim().toLowerCase() === address) throw new RegisterRejected("weak-password");
  const invite = mode === "invite";
  // The invite is checked before the email, so a bad code never reveals whether an address is taken.
  if (invite && !(await inviteConsumable(input.code.trim(), db))) throw new RegisterRejected("invite-invalid");
  const [taken] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${address}`;
  if (taken) throw new RegisterRejected("email-taken");

  const passwordHash = await hashPassword(input.password);
  try {
    return await db.begin(async (tx) => {
      // Won again inside the transaction: a concurrent registration may have taken the last use.
      if (invite && !(await consumeInvite(input.code.trim(), tx))) throw new RegisterRejected("invite-invalid");
      const [user] = await tx<SessionUser[]>`
        INSERT INTO users (id, email, password_hash, display_name)
        VALUES (${newUuid()}, ${address}, ${passwordHash}, ${address.split("@")[0] ?? null})
        RETURNING id, email, display_name AS "displayName", locale, timezone, role`;
      const token = await createSession(user!.id, { userAgent: input.userAgent, ip: input.ip }, tx);
      return { token, user: user! };
    });
  } catch (error) {
    // A racer inserted the same address between our check and the insert (citext unique).
    if ((error as { code?: string }).code === "23505") throw new RegisterRejected("email-taken");
    throw error;
  }
}
