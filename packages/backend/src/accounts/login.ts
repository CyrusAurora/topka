// The sign-in use case (master design D6/3.4): email and password become a session. A unknown
// address and a wrong password are the same failure, and a disabled account is refused even with the
// right password. Lockout after repeated failures arrives with the abuse-protection step.
import { randomBytes } from "node:crypto";
import { sql, type Db } from "../db.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { createSession, type SessionUser } from "./session.ts";

export type LoginReason = "invalid-credentials" | "account-disabled";

export class LoginRejected extends Error {
  readonly reason: LoginReason;
  constructor(reason: LoginReason) {
    super(reason);
    this.reason = reason;
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
  const [user] = await db<{ id: string; password_hash: string; status: string }[]>`
    SELECT id, password_hash, status FROM users WHERE email = ${address}`;
  if (!user) {
    await verifyPassword(DUMMY_HASH, input.password);
    throw new LoginRejected("invalid-credentials");
  }
  if (user.status !== "active") throw new LoginRejected("account-disabled");
  if (!(await verifyPassword(user.password_hash, input.password))) throw new LoginRejected("invalid-credentials");

  const token = await createSession(user.id, { userAgent: input.userAgent, ip: input.ip }, db);
  const [fresh] = await db<SessionUser[]>`
    UPDATE users SET last_login_at = now() WHERE id = ${user.id}
    RETURNING id, email, display_name AS "displayName", locale, role`;
  return { token, user: fresh! };
}
