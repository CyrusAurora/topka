// Server-side sessions for user accounts (master design D6/3.4): the browser holds a random 32-byte
// token, the database only its SHA-256, so a database leak yields no usable credentials. A session
// resolves only while it is unexpired and the account still active.
import { randomBytes } from "node:crypto";
import { sql, type Db } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

/**
 * The user session cookie; the admin keeps its own (admin/auth.ts). SESSION_COOKIE_NAME overrides the
 * name, e.g. to keep an existing deployment's cookie so signed-in readers stay signed in.
 */
export const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "topka_session";
export const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  locale: string;
  timezone: string;
  role: string;
}

export interface SessionCreateOptions {
  userAgent?: string | null;
  ip?: string | null;
}

export async function createSession(userId: string, options: SessionCreateOptions, db: Db = sql): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db`
    INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
    VALUES (${sha256(token)}, ${userId}, ${new Date(Date.now() + SESSION_DAYS * 86400_000)},
            ${options.userAgent?.slice(0, 300) ?? null}, ${options.ip ?? null}::inet)`;
  return token;
}

export async function resolveSession(token: string | undefined | null, db: Db = sql): Promise<SessionUser | null> {
  if (!token) return null;
  const [row] = await db<SessionUser[]>`
    SELECT u.id, u.email, u.display_name AS "displayName", u.locale, u.timezone, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sha256(token)} AND s.expires_at > now() AND u.status = 'active'`;
  return row ?? null;
}

export async function destroySession(token: string | undefined | null, db: Db = sql): Promise<void> {
  if (!token) return;
  await db`DELETE FROM sessions WHERE id = ${sha256(token)}`;
}
