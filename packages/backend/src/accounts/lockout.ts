// Per-account sign-in lockout (threat model: sessions and login). The per-address rate limit stops one
// client from guessing fast; this stops many clients guessing one account. Keyed by the normalised
// address whether or not an account has it, so the answer is the same for both: a lock says nothing
// about existence. Each attempt is reserved before the password is checked (one row update under the
// row lock), so a burst of parallel guesses gets at most `threshold` tries per window.
//
// After `threshold` attempts within `window` the address is locked for base·2^(locks so far), capped
// at `max`; a successful sign-in clears the record, and a lock history older than a day is forgotten.
import { sha256 } from "../lib/ids.ts";
import { sql, type Db } from "../db.ts";

export interface LockoutPolicy {
  threshold: number;
  windowSeconds: number;
  baseLockSeconds: number;
  maxLockSeconds: number;
}

const int = (v: string | undefined, fallback: number, min: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? n : fallback;
};

/** LOGIN_LOCK_THRESHOLD (5), LOGIN_LOCK_WINDOW_SECONDS (900), LOGIN_LOCK_BASE_SECONDS (60), LOGIN_LOCK_MAX_SECONDS (3600). */
export function lockoutPolicy(env: NodeJS.ProcessEnv = process.env): LockoutPolicy {
  const baseLockSeconds = int(env.LOGIN_LOCK_BASE_SECONDS, 60, 1);
  return {
    threshold: int(env.LOGIN_LOCK_THRESHOLD, 5, 1),
    windowSeconds: int(env.LOGIN_LOCK_WINDOW_SECONDS, 900, 1),
    baseLockSeconds,
    maxLockSeconds: Math.max(baseLockSeconds, int(env.LOGIN_LOCK_MAX_SECONDS, 3600, 1)),
  };
}

export const lockKey = (address: string) => sha256(`login:${address.trim().toLowerCase()}`);

export type Reservation = { allowed: true } | { allowed: false; retryAfter: number };

/**
 * Counts one attempt for the address, or refuses it while the address is locked. The attempt that
 * would go past the threshold starts the lock instead of being tried.
 */
export async function reserveAttempt(address: string, policy = lockoutPolicy(), db: Db = sql): Promise<Reservation> {
  const key = lockKey(address);
  const run = async (tx: Db): Promise<Reservation> => {
    await tx`INSERT INTO login_throttle (key_hash) VALUES (${key}) ON CONFLICT (key_hash) DO NOTHING`;
    // The row lock serialises concurrent attempts on one address: each sees the count the last left.
    const [row] = await tx<{ attempts: number; window_started_at: Date; locked_until: Date | null; lock_count: number; now: Date }[]>`
      SELECT attempts, window_started_at, locked_until, lock_count, now() AS now FROM login_throttle WHERE key_hash = ${key} FOR UPDATE`;
    const now = row!.now.getTime();
    if (row!.locked_until && row!.locked_until.getTime() > now) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((row!.locked_until.getTime() - now) / 1000)) };
    }
    // A lock history older than a day is forgotten; a window that ran out starts over.
    const lockCount = row!.locked_until && row!.locked_until.getTime() < now - 86_400_000 ? 0 : row!.lock_count;
    const fresh = row!.window_started_at.getTime() < now - policy.windowSeconds * 1000;
    const attempts = fresh ? 0 : row!.attempts;
    if (attempts >= policy.threshold) {
      const seconds = Math.min(policy.maxLockSeconds, policy.baseLockSeconds * 2 ** lockCount);
      await tx`UPDATE login_throttle SET attempts = 0, window_started_at = now(), lock_count = ${lockCount + 1},
                 locked_until = now() + make_interval(secs => ${seconds}), updated_at = now() WHERE key_hash = ${key}`;
      return { allowed: false, retryAfter: seconds };
    }
    await tx`UPDATE login_throttle SET attempts = ${attempts + 1}, lock_count = ${lockCount},
               window_started_at = ${fresh ? new Date(now) : row!.window_started_at}, updated_at = now() WHERE key_hash = ${key}`;
    return { allowed: true };
  };
  return "begin" in db ? (db as typeof sql).begin(run) : run(db);
}

/** A successful sign-in clears the address's record. */
export async function clearAttempts(address: string, db: Db = sql): Promise<void> {
  await db`DELETE FROM login_throttle WHERE key_hash = ${lockKey(address)}`;
}

/** Drops records nobody has touched for a day and that hold no lock (addresses sprayed once). */
export async function pruneAttempts(db: Db = sql): Promise<number> {
  const rows = await db`DELETE FROM login_throttle WHERE updated_at < now() - interval '1 day'
                        AND (locked_until IS NULL OR locked_until < now()) RETURNING 1`;
  return rows.length;
}
