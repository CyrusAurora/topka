// Per-account sign-in lockout (lockout.ts): many clients guessing one address get `threshold` tries
// per window, then 429 with Retry-After for a lock that doubles each time; a locked address is refused
// even with the right password; the answer is identical for an address with no account; a success
// clears the record; a disabled account is only told so after the right password.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { lockKey, lockoutPolicy, pruneAttempts } from "@topka/backend/accounts/lockout";
import { buildApp } from "../apps/api/src/app.ts";

const T = `lock-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `${T}-long-enough`;
const app = await buildApp();
after(async () => {
  await app.close();
  await closeDb();
});

let n = 0;
let ipSeq = 0;
/** A different client address for every request: the per-client limit never applies. */
const nextIp = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
async function account(): Promise<string> {
  const address = `user${++n}-${T}@example.com`;
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `lock ${T}` })).code;
  await registerWithInvite({ code, email: address, password: PASSWORD });
  return address;
}
const login = (email: string, password: string, ip = nextIp()) =>
  app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, remoteAddress: ip, payload: JSON.stringify({ email, password }) });
const shape = (r: Awaited<ReturnType<typeof login>>) => {
  const { requestId: _drop, ...body } = r.json() as Record<string, unknown>;
  return { status: r.statusCode, retryAfter: r.headers["retry-after"], body };
};
const forwardLock = (email: string) =>
  sql`UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE key_hash = ${lockKey(email)}`;

test("the policy defaults: 5 tries per 15 minutes, a 1 minute lock doubling up to an hour", () => {
  assert.deepEqual(lockoutPolicy({}), { threshold: 5, windowSeconds: 900, baseLockSeconds: 60, maxLockSeconds: 3600 });
  assert.deepEqual(lockoutPolicy({ LOGIN_LOCK_THRESHOLD: "0", LOGIN_LOCK_MAX_SECONDS: "5" }).threshold, 5, "nonsense falls back");
});

test("a distributed attack (a new address for every try) gets 5 tries, then 429 even for the right password", async () => {
  const email = await account();
  const answers = [];
  for (let i = 0; i < 8; i++) answers.push((await login(email, `${PASSWORD}-guess-${i}`)).statusCode);
  assert.deepEqual(answers, [401, 401, 401, 401, 401, 429, 429, 429]);
  const right = await login(email, PASSWORD);
  assert.equal(right.statusCode, 429, "a locked address is refused before its password is checked");
  assert.equal(right.headers["set-cookie"], undefined, "no session while locked");
  assert.equal(right.json().code, "rate_limited");
  const wait = Number(right.headers["retry-after"]);
  assert.ok(wait >= 1 && wait <= 60, `Retry-After ${wait}`);
  assert.equal(right.json().retryAfter, wait);
});

test("parallel guesses cannot slip past the threshold", async () => {
  const email = await account();
  const statuses = (await Promise.all(Array.from({ length: 20 }, (_, i) => login(email, `${PASSWORD}-burst-${i}`)))).map((r) => r.statusCode);
  assert.equal(statuses.filter((s) => s === 401).length, 5, statuses.join(","));
  assert.equal(statuses.filter((s) => s === 429).length, 15);
});

test("an address without an account gets exactly the same answers, so a lock reveals nothing", async () => {
  const real = await account();
  const ghost = `ghost-${T}@example.com`;
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(shape(await login(real, `wrong-${i}-${T}`)), shape(await login(ghost, `wrong-${i}-${T}`)));
  }
  const a = shape(await login(real, PASSWORD));
  const b = shape(await login(ghost, PASSWORD));
  assert.equal(a.status, 429);
  assert.deepEqual(a, b);
  assert.equal(a.body.detail, "尝试太频繁了，请稍后再试。");
});

test("each lock doubles: 60 s, then 120 s, then 240 s, capped at the maximum", async () => {
  const email = await account();
  const lockAfterFive = async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login(email, `nope-${i}`)).statusCode, 401);
    return Number((await login(email, "nope-6")).headers["retry-after"]);
  };
  assert.equal(await lockAfterFive(), 60);
  await forwardLock(email);
  assert.equal(await lockAfterFive(), 120);
  await forwardLock(email);
  assert.equal(await lockAfterFive(), 240);
  await sql`UPDATE login_throttle SET lock_count = 20, locked_until = now() - interval '1 second' WHERE key_hash = ${lockKey(email)}`;
  assert.equal(await lockAfterFive(), 3600, "never longer than LOGIN_LOCK_MAX_SECONDS");
});

test("a successful sign-in clears the count", async () => {
  const email = await account();
  for (let i = 0; i < 4; i++) assert.equal((await login(email, `nope-${i}`)).statusCode, 401);
  assert.equal((await login(email, PASSWORD)).statusCode, 200);
  assert.equal((await sql`SELECT 1 FROM login_throttle WHERE key_hash = ${lockKey(email)}`).length, 0);
  for (let i = 0; i < 5; i++) assert.equal((await login(email, `again-${i}`)).statusCode, 401, "a fresh five");
  assert.equal((await login(email, "again-6")).statusCode, 429);
});

test("tries older than the window start over", async () => {
  const email = await account();
  for (let i = 0; i < 4; i++) await login(email, `old-${i}`);
  await sql`UPDATE login_throttle SET window_started_at = now() - interval '16 minutes' WHERE key_hash = ${lockKey(email)}`;
  for (let i = 0; i < 5; i++) assert.equal((await login(email, `new-${i}`)).statusCode, 401);
  assert.equal((await login(email, "new-6")).statusCode, 429);
});

test("the address is matched case-insensitively and stored only as a hash", async () => {
  const email = await account();
  for (let i = 0; i < 5; i++) await login(i % 2 ? email.toUpperCase() : ` ${email} `, `case-${i}`);
  assert.equal((await login(email, PASSWORD)).statusCode, 429);
  const rows = await sql`SELECT key_hash FROM login_throttle WHERE key_hash = ${lockKey(email)}`;
  assert.equal(rows.length, 1);
  assert.ok(!(await sql`SELECT 1 FROM login_throttle WHERE key_hash LIKE ${"%" + T + "%"}`).length, "no address in the clear");
});

test("a disabled account answers like a wrong password until the right one is given", async () => {
  const email = await account();
  await sql`UPDATE users SET status = 'disabled' WHERE email = ${email}`;
  const wrong = await login(email, `${PASSWORD}-wrong`);
  const ghost = await login(`ghost2-${T}@example.com`, `${PASSWORD}-wrong`);
  assert.deepEqual(shape(wrong), shape(ghost), "existence of a disabled account is not revealed");
  assert.equal(wrong.json().code, "invalid_credentials");
  const right = await login(email, PASSWORD);
  assert.deepEqual([right.statusCode, right.json().code], [403, "account_disabled"]);
});

test("daily retention drops stale records that hold no lock", async () => {
  const stale = `stale-${T}@example.com`;
  const locked = `locked-${T}@example.com`;
  await login(stale, "x");
  for (let i = 0; i < 6; i++) await login(locked, "x");
  await sql`UPDATE login_throttle SET updated_at = now() - interval '2 days' WHERE key_hash IN (${lockKey(stale)}, ${lockKey(locked)})`;
  await sql`UPDATE login_throttle SET locked_until = now() + interval '1 hour' WHERE key_hash = ${lockKey(locked)}`;
  assert.ok((await pruneAttempts()) >= 1);
  assert.equal((await sql`SELECT 1 FROM login_throttle WHERE key_hash = ${lockKey(stale)}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM login_throttle WHERE key_hash = ${lockKey(locked)}`).length, 1, "a live lock is kept");
});
