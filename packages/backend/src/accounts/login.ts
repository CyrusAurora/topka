// The sign-in use case (master design D6/3.4): email and password become a session. An unknown
// address and a wrong password are the same failure; a disabled account is told so only after the
// right password (before it, it is the same failure too, so the answer never reveals an account).
// Repeated attempts on one address lock it for a while (lockout.ts), whether or not it exists.
import { randomBytes } from "node:crypto";
import { sql, type Db } from "../db.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { createSession, type SessionUser } from "./session.ts";
import { clearAttempts, reserveAttempt } from "./lockout.ts";

export type LoginReason = "invalid-credentials" | "account-disabled" | "locked";

export class LoginRejected extends Error {
  readonly reason: LoginReason;
  /** Seconds until a locked address may try again ("locked" only). */
  readonly retryAfter?: number;
  constructor(reason: LoginReason, retryAfter?: number) {
    super(reason);
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

/**
 * A hash of an unguessable string, verified against when the address is unknown so that answering
 * takes as long as a real check and request timing reveals nothing.
 */
const DUMMY_HASH = await hashPassword(`no-such-user-${randomBytes(16).toString("hex")}`);

export interface LoginInput {
  email: string;
  password: string;
  userAgent?: string | null;
  ip?: string | null;
}

export interface LoginResult {
  token: string;
  user: SessionUser;
}

export async function loginWithPassword(input: LoginInput, db: Db = sql): Promise<LoginResult> {
  const address = input.email.trim().toLowerCase();
  // Counted before any password is compared; a locked address is refused without one.
  const reservation = await reserveAttempt(address, undefined, db);
  if (!reservation.allowed) throw new LoginRejected("locked", reservation.retryAfter);
  const [user] = await db<{ id: string; password_hash: string; status: string }[]>`
    SELECT id, password_hash, status FROM users WHERE email = ${address}`;
  if (!user) {
    await verifyPassword(DUMMY_HASH, input.password);
    throw new LoginRejected("invalid-credentials");
  }
  if (!(await verifyPassword(user.password_hash, input.password))) throw new LoginRejected("invalid-credentials");
  if (user.status !== "active") throw new LoginRejected("account-disabled");
  await clearAttempts(address, db);

  const token = await createSession(user.id, { userAgent: input.userAgent, ip: input.ip }, db);
  const [fresh] = await db<SessionUser[]>`
    UPDATE users SET last_login_at = now() WHERE id = ${user.id}
    RETURNING id, email, display_name AS "displayName", locale, timezone, role`;
  return { token, user: fresh! };
}
