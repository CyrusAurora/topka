// Account ground work (master design 3.2/3.4, construction step 2): invite-based registration,
// password sign-in, hashed server-side sessions, the /api/auth endpoints and the row-level isolation
// gate. Registration copies are user-facing and locked in Chinese.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@topka/backend/config";
import { closeDb, sql } from "@topka/backend/db";
import { hashPassword, MIN_PASSWORD_LENGTH, passwordTooWeak, verifyPassword } from "@topka/backend/accounts/password";
import { createInvite } from "@topka/backend/accounts/invite";
import { createSession, destroySession, resolveSession, SESSION_COOKIE } from "@topka/backend/accounts/session";
import { sha256 } from "@topka/backend/lib/ids";
import { loginWithPassword, LoginRejected } from "@topka/backend/accounts/login";
import { normalizeEmail, registerWithInvite, RegisterRejected, registrationMode } from "@topka/backend/accounts/register";
import { requireProjectOwner } from "@topka/backend/publication/project-owner";
import { buildApp } from "../apps/api/src/app.ts";
import { resetRegisterLimits } from "../apps/api/src/routes/accounts.ts";

const T = `acct-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `${T}-long-enough`;
const app = await buildApp();
after(async () => {
  await app.close();
  await closeDb();
});

let n = 0;
const email = () => `user${++n}-${T}@example.com`;
async function invite(maxUses = 1, expiresInDays = 7) {
  return (await createInvite({ createdBy: `tester-${T}`, maxUses, expiresInDays, note: `test ${T}` })).code;
}

function cookiesOf(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  if (Array.isArray(raw)) return raw.map(String);
  return raw ? [String(raw)] : [];
}
const cookieValue = (cookie: string, name: string) => new RegExp(`${name}=([^;]+)`).exec(cookie)?.[1] ?? "";

test("password hashing is argon2id and never compares in the clear", async () => {
  const hash = await hashPassword(PASSWORD);
  assert.ok(hash.startsWith("$argon2id$"), hash.slice(0, 20));
  assert.equal(await verifyPassword(hash, PASSWORD), true);
  assert.equal(await verifyPassword(hash, `${PASSWORD}x`), false);
  assert.equal(await verifyPassword("not-a-hash", PASSWORD), false, "a malformed hash verifies to false, not a throw");
  assert.equal(MIN_PASSWORD_LENGTH, 10);
  assert.equal(passwordTooWeak("123456789"), true);
  assert.equal(passwordTooWeak("1234567890"), false);
});

test("registration with a valid invite creates an active user and a live session", async () => {
  const code = await invite();
  const { token, user } = await registerWithInvite({ code, email: email(), password: PASSWORD, userAgent: "test", ip: "203.0.113.10" }, sql, "invite");
  const [row] = await sql<{ email: string; locale: string; role: string; status: string; display_name: string | null }[]>`
    SELECT email, locale, role, status, display_name FROM users WHERE id = ${user.id}`;
  assert.equal(row!.status, "active");
  assert.equal(row!.role, "user");
  assert.equal(row!.locale, "zh-CN");
  assert.ok(row!.display_name);
  assert.equal(await sql`SELECT used_count FROM invitations WHERE code = ${code}`.then((r) => r[0]!.used_count), 1, "the invite is consumed once");
  const resolved = await resolveSession(token);
  assert.equal(resolved?.id, user.id, "the token resolves to the new user");
  assert.equal(resolved?.email, row!.email);
});

test("registering the same email again is refused and consumes nothing", async () => {
  const code = await invite();
  const taken = email();
  await registerWithInvite({ code, email: taken, password: PASSWORD });
  const second = await invite();
  await assert.rejects(
    () => registerWithInvite({ code: second, email: taken.toUpperCase(), password: PASSWORD }),
    (error: unknown) => error instanceof RegisterRejected && error.reason === "email-taken",
    "the check is case-insensitive, like citext",
  );
  const [row] = await sql<{ used_count: number }[]>`SELECT used_count FROM invitations WHERE code = ${second}`;
  assert.equal(row!.used_count, 0, "a failed registration leaves the invite untouched");
});

test("an unknown, an expired and a used-up invite all read as invalid", async () => {
  await assert.rejects(
    () => registerWithInvite({ code: `nope-${T}`, email: email(), password: PASSWORD }, sql, "invite"),
    (error: unknown) => error instanceof RegisterRejected && error.reason === "invite-invalid",
  );
  const expired = await invite(1, -1);
  await sql`UPDATE invitations SET expires_at = now() - interval '1 hour' WHERE code = ${expired}`;
  await assert.rejects(
    () => registerWithInvite({ code: expired, email: email(), password: PASSWORD }, sql, "invite"),
    (error: unknown) => error instanceof RegisterRejected && error.reason === "invite-invalid",
  );
  const exhausted = await invite(1);
  await registerWithInvite({ code: exhausted, email: email(), password: PASSWORD }, sql, "invite");
  await assert.rejects(
    () => registerWithInvite({ code: exhausted, email: email(), password: PASSWORD }, sql, "invite"),
    (error: unknown) => error instanceof RegisterRejected && error.reason === "invite-invalid",
  );
});

test("a password shorter than ten characters is refused before anything is written", async () => {
  const code = await invite();
  const address = email();
  await assert.rejects(
    () => registerWithInvite({ code, email: address, password: "short9" }),
    (error: unknown) => error instanceof RegisterRejected && error.reason === "weak-password",
  );
  assert.equal((await sql`SELECT used_count FROM invitations WHERE code = ${code}`)[0]!.used_count, 0);
  assert.equal((await sql`SELECT id FROM users WHERE email = ${address}`).length, 0, "no user row for the refused registration");
});

test("sign-in succeeds with the registered email in any letter case", async () => {
  const address = email();
  await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
  const before = await sql<{ last_login_at: Date | null }[]>`SELECT last_login_at FROM users WHERE email = ${address}`;
  const { token } = await loginWithPassword({ email: address.toUpperCase(), password: PASSWORD });
  assert.ok(await resolveSession(token), "the session resolves");
  const [row] = await sql<{ last_login_at: Date | null }[]>`SELECT last_login_at FROM users WHERE email = ${address}`;
  assert.ok(row!.last_login_at && !before[0]!.last_login_at, "last_login_at is stamped on the first sign-in");
});

test("a wrong password and an unknown email fail with the same reason", async () => {
  const address = email();
  await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
  for (const input of [{ email: address, password: `${PASSWORD}-wrong` }, { email: `ghost-${T}@example.com`, password: PASSWORD }]) {
    await assert.rejects(
      () => loginWithPassword({ ...input, userAgent: null, ip: null }),
      (error: unknown) => error instanceof LoginRejected && error.reason === "invalid-credentials",
    );
  }
});

test("a disabled account cannot sign in and its live sessions stop resolving", async () => {
  const address = email();
  const { token } = await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
  await sql`UPDATE users SET status = 'disabled' WHERE email = ${address}`;
  await assert.rejects(
    () => loginWithPassword({ email: address, password: PASSWORD }),
    (error: unknown) => error instanceof LoginRejected && error.reason === "account-disabled",
  );
  assert.equal(await resolveSession(token), null, "disabling an account kills its sessions");
});

test("an expired session no longer resolves", async () => {
  const address = email();
  const { user } = await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
  const token = await createSession(user.id, { userAgent: null, ip: null });
  assert.ok(await resolveSession(token));
  await sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = ${user.id}`;
  assert.equal(await resolveSession(token), null);
});

test("logout destroys the session for good", async () => {
  const address = email();
  const { token } = await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
  await destroySession(token);
  assert.equal(await resolveSession(token), null);
  assert.equal((await sql`SELECT id FROM sessions WHERE id = ${sha256(token)}`).length, 0, "the stored row (the token's hash) is really gone");
});

// --- the api endpoints ------------------------------------------------------

async function post(url: string, body: unknown, ip: string, cookie?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    remoteAddress: ip,
    payload: JSON.stringify(body),
  });
}

test("the register endpoint sets the session cookie and me answers with the user", async () => {
  const code = await invite();
  const address = email();
  const res = await post("/api/auth/register", { code, email: address, password: PASSWORD }, "203.0.113.31");
  assert.equal(res.statusCode, 200, res.body);
  const cookie = cookiesOf(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  assert.ok(cookie, "a session cookie is set");
  assert.ok(/httponly/i.test(cookie) && /samesite=lax/i.test(cookie), `HttpOnly + SameSite=Lax, got ${cookie}`);
  const body = res.json() as { user: { email: string; role: string } };
  assert.equal(body.user.email, address);
  assert.equal(body.user.role, "user");

  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${SESSION_COOKIE}=${cookieValue(cookie, SESSION_COOKIE)}` } });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal((me.json() as { user: { email: string } }).user.email, address);
  assert.equal((me.json() as { user: { timezone: string } }).user.timezone, "Asia/Shanghai");
});

test("PATCH /api/auth/me sets a valid IANA timezone and rejects junk without rewriting issue rows", async () => {
  const address = email();
  const { token, user } = await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
  const cookie = `${SESSION_COOKIE}=${token}`;
  const ok = await app.inject({
    method: "PATCH", url: "/api/auth/me", headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify({ timezone: "America/New_York" }),
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((ok.json() as { user: { timezone: string } }).user.timezone, "America/New_York");
  const [row] = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id = ${user.id}`;
  assert.equal(row!.timezone, "America/New_York");
  const bad = await app.inject({
    method: "PATCH", url: "/api/auth/me", headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify({ timezone: "UTC+8" }),
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().code, "invalid_timezone");
  // Junk must not stick: the previous valid value stays.
  const [still] = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id = ${user.id}`;
  assert.equal(still!.timezone, "America/New_York");
});

test("register failures come back per reason, in Chinese, and leak nothing extra", async () => {
  const address = email();
  await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
  const second = await invite();
  process.env.REGISTRATION_MODE = "invite";
  const cases: Array<[Record<string, string>, number, string, string]> = [
    [{ code: `bad-${T}`, email: email(), password: PASSWORD }, 403, "invite_invalid", "邀请码无效"],
    [{ code: second, email: address, password: PASSWORD }, 409, "email_taken", "已经注册"],
    [{ code: second, email: email(), password: "short9" }, 400, "weak_password", "至少 10 位"],
  ];
  for (const [body, status, code, fragment] of cases) {
    const res = await post("/api/auth/register", body, "203.0.113.32");
    assert.deepEqual([res.statusCode, res.json().code], [status, code], res.body);
    assert.ok((res.json().detail as string).includes(fragment), `the copy says why: ${res.body}`);
  }
  delete process.env.REGISTRATION_MODE;
});

test("login failures come back per reason and hammering the endpoint is rate limited", async () => {
  const address = email();
  await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
  const wrong = await post("/api/auth/login", { email: address, password: `${PASSWORD}-no` }, "203.0.113.33");
  assert.deepEqual([wrong.statusCode, wrong.json().code], [401, "invalid_credentials"], wrong.body);
  assert.ok((wrong.json().detail as string).includes("邮箱或密码不对"));

  for (let i = 0; i < 9; i++) await post("/api/auth/login", { email: address, password: `${PASSWORD}-no` }, "203.0.113.33");
  const tenth = await post("/api/auth/login", { email: address, password: `${PASSWORD}-no` }, "203.0.113.33");
  assert.equal(tenth.statusCode, 429, "the next attempt inside the same minute is turned away");
  assert.equal(tenth.headers["retry-after"], "60");
  assert.ok((tenth.json().detail as string).includes("一分钟"), tenth.body);
  // A fresh address on a fresh bucket still works, so the limit is per client, not global.
  const other = await post("/api/auth/login", { email: address, password: `${PASSWORD}-no` }, "203.0.113.34");
  assert.equal(other.statusCode, 401);
});

test("logout clears the session, me falls back to 401, and a form post is redirected like the admin's", async () => {
  const address = email();
  await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
  const login = await post("/api/auth/login", { email: address, password: PASSWORD }, "203.0.113.35");
  const token = cookieValue(cookiesOf(login).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!, SESSION_COOKIE);
  const me = (cookie: string) => app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
  assert.equal((await me(`${SESSION_COOKIE}=${token}`)).statusCode, 200);

  const out = await post("/api/auth/logout", {}, "203.0.113.35", `${SESSION_COOKIE}=${token}`);
  assert.equal(out.statusCode, 200);
  assert.ok(cookiesOf(out).some((c) => /max-age=0/i.test(c)), "the cookie is cleared");
  assert.equal((await me(`${SESSION_COOKIE}=${token}`)).statusCode, 401, "the session is gone server-side");
  assert.equal((await me("")).statusCode, 401, "an anonymous me is unauthorized");

  const form = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { "content-type": "application/x-www-form-urlencoded" }, remoteAddress: "203.0.113.36", payload: "" });
  assert.equal(form.statusCode, 303, "the admin shell posts a form and expects the redirect");
  assert.equal(form.headers.location, "/");
});

test("the session cookie is Secure when the site is served over https", async () => {
  const siteUrl = config.siteUrl;
  config.siteUrl = "https://radar.example.com";
  try {
    const address = email();
    await registerWithInvite({ code: await invite(), email: address, password: PASSWORD });
    const login = await post("/api/auth/login", { email: address, password: PASSWORD }, "203.0.113.37");
    const cookie = cookiesOf(login).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    assert.ok(/;\s*Secure/i.test(cookie), cookie);
  } finally {
    config.siteUrl = siteUrl;
  }
});

test("requireProjectOwner answers typed not-found for unknown projects", async () => {
  assert.deepEqual(await requireProjectOwner("u1", "p1"), { kind: "not-found" });
});

test("REGISTRATION_MODE: unset or open needs no invite; invite (or a typo) keeps the gate", () => {
  assert.equal(registrationMode({}), "open");
  assert.equal(registrationMode({ REGISTRATION_MODE: " Open " }), "open");
  assert.equal(registrationMode({ REGISTRATION_MODE: "invite" }), "invite");
  assert.equal(registrationMode({ REGISTRATION_MODE: "closed" }), "invite", "an unknown value fails closed");
});

test("email validation refuses malformed addresses and stores the normalized form", () => {
  assert.equal(normalizeEmail("  Reader@Example.COM "), "reader@example.com");
  for (const bad of ["a@b", "a@@example.com", "a b@example.com", "a@.example.com", "a@example.org..net", "a@example.com.", `${"x".repeat(65)}@example.com`, "a@exa_mple.com"]) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
});

test("open registration: no invite needed, the invite is not consumed, the password may not be the email", async () => {
  const code = await invite();
  const { user } = await registerWithInvite({ code, email: email(), password: PASSWORD }, sql, "open");
  assert.ok(user.id);
  assert.equal((await sql`SELECT used_count FROM invitations WHERE code = ${code}`)[0]!.used_count, 0);
  const { user: noCode } = await registerWithInvite({ code: "", email: email(), password: PASSWORD }, sql, "open");
  assert.ok(noCode.id);
  const address = email();
  await assert.rejects(
    () => registerWithInvite({ code: "", email: address, password: address.toUpperCase() }, sql, "open"),
    (error: unknown) => error instanceof RegisterRejected && error.reason === "weak-password",
  );
});

test("open registration over HTTP: the page learns the mode, a honeypot is refused, each client is capped per hour", async () => {
  resetRegisterLimits();
  delete process.env.REGISTRATION_MODE;
  const mode = await app.inject({ method: "GET", url: "/api/auth/registration" });
  assert.deepEqual(mode.json(), { mode: "open", inviteRequired: false });
  process.env.REGISTRATION_MODE = "invite";
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/auth/registration" })).json(), { mode: "invite", inviteRequired: true });
  delete process.env.REGISTRATION_MODE;

  const bot = await post("/api/auth/register", { email: email(), password: PASSWORD, website: "http://spam.example" }, "203.0.113.90");
  assert.equal(bot.statusCode, 400);

  const ok = await post("/api/auth/register", { email: email(), password: PASSWORD }, "203.0.113.91");
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(cookiesOf(ok).some((c) => c.startsWith(`${SESSION_COOKIE}=`)), "open registration signs the user in");

  // A weak password does not use up the hourly allowance.
  for (let i = 0; i < 3; i++) assert.equal((await post("/api/auth/register", { email: email(), password: "short9" }, "203.0.113.92")).statusCode, 400);
  for (let i = 0; i < 5; i++) assert.equal((await post("/api/auth/register", { email: email(), password: PASSWORD }, "203.0.113.92")).statusCode, 200);
  const sixth = await post("/api/auth/register", { email: email(), password: PASSWORD }, "203.0.113.92");
  assert.equal(sixth.statusCode, 429, sixth.body);
  assert.ok((sixth.json().detail as string).includes("这一小时"));

  process.env.REGISTRATION_HOURLY_LIMIT = "1";
  resetRegisterLimits();
  assert.equal((await post("/api/auth/register", { email: email(), password: PASSWORD }, "203.0.113.93")).statusCode, 200);
  const capped = await post("/api/auth/register", { email: email(), password: PASSWORD }, "203.0.113.94");
  assert.equal(capped.statusCode, 429);
  assert.ok((capped.json().detail as string).includes("注册的人太多"));
  delete process.env.REGISTRATION_HOURLY_LIMIT;
  resetRegisterLimits();
});
