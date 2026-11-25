// User account endpoints (master design D6/3.4, J1): registration (open by default, or invite-only via
// REGISTRATION_MODE), password sign-in,
// logout and the session's own view. Sessions are HttpOnly + SameSite=Lax cookies holding a token
// whose hash is the database row; failures answer per reason in Chinese and reveal nothing extra.
// The admin keeps its own session kind (routes/admin-auth.ts); POST /api/auth/logout serves both,
// because the admin shell posts its form to the same path.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@topka/backend/config";
import { cookie, endSession, parseCookies, SESSION_COOKIE as ADMIN_SESSION_COOKIE } from "@topka/backend/admin/auth";
import { LoginRejected, loginWithPassword } from "@topka/backend/accounts/login";
import { RegisterRejected, registerWithInvite, registrationMode } from "@topka/backend/accounts/register";
import { destroySession, resolveSession, SESSION_COOKIE } from "@topka/backend/accounts/session";
import { verifyPassword } from "@topka/backend/accounts/password";
import { isValidTimeZone } from "@topka/backend/projects/issue-rules";
import { isValidLocale } from "@topka/backend/accounts/locale";
import { sql } from "@topka/backend/db";
import { sendProblem } from "../http/respond.ts";
import { LIMITS } from "../http/rate-limit.ts";

/** Sign-in and registration share one per-client window (master design 3.5: 10 per IP per minute). */
const RATE_PER_MINUTE = 10;
const windows = new Map<string, number[]>();
function limited(key: string): boolean {
  const now = Date.now();
  if (windows.size > 5000) windows.clear();
  const list = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= RATE_PER_MINUTE) return true;
  list.push(now);
  windows.set(key, list);
  return false;
}

/** Open registration's abuse basics, on top of the shared per-minute window: each client may create (or
 * probe taken addresses) a few times an hour — typos in a weak password do not count — and the instance as a whole creates at most REGISTRATION_HOURLY_LIMIT accounts
 * an hour (default 30; a burst beyond that waits, it is not an outage). In memory, per api process. */
const REGISTER_PER_CLIENT_HOUR = 5;
const registerTries = new Map<string, number[]>();
let created: number[] = [];
function hourly(list: number[], now: number): number[] {
  return list.filter((t) => now - t < 3_600_000);
}
function registerLimited(ip: string): "client" | "instance" | null {
  const now = Date.now();
  if (registerTries.size > 5000) registerTries.clear();
  const tries = hourly(registerTries.get(ip) ?? [], now);
  if (tries.length >= REGISTER_PER_CLIENT_HOUR) return "client";
  created = hourly(created, now);
  const cap = Number(process.env.REGISTRATION_HOURLY_LIMIT ?? 30);
  if (Number.isFinite(cap) && cap > 0 && created.length >= cap) return "instance";
  return null;
}
function noteRegisterTry(ip: string): void {
  const now = Date.now();
  registerTries.set(ip, [...hourly(registerTries.get(ip) ?? [], now), now]);
}
/** Test hook: forget the registration windows. */
export function resetRegisterLimits(): void {
  registerTries.clear();
  created = [];
}

/** Cookies are Secure whenever the site is served over HTTPS. */
const secure = () => config.siteUrl.startsWith("https://");

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.header("Set-Cookie", cookie(SESSION_COOKIE, token, 30 * 86400, secure()));
}

function clearSessionCookies(reply: FastifyReply) {
  reply.header("Set-Cookie", [cookie(SESSION_COOKIE, "", 0, secure()), cookie(ADMIN_SESSION_COOKIE, "", 0, secure())]);
}

function userBody(user: { id: string; email: string; displayName: string | null; locale: string; timezone: string; role: string }) {
  return { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale, timezone: user.timezone, role: user.role };
}

const REGISTER_PROBLEMS = {
  "invalid-email": { status: 400, code: "invalid_email", detail: "邮箱格式看起来不对，请检查后再试。" },
  "weak-password": { status: 400, code: "weak_password", detail: "密码至少 10 位。" },
  "invite-invalid": { status: 403, code: "invite_invalid", detail: "邀请码无效，请核对后再试。" },
  "email-taken": { status: 409, code: "email_taken", detail: "这个邮箱已经注册过了。" },
} as const;

const LOGIN_PROBLEMS = {
  "invalid-credentials": { status: 401, code: "invalid_credentials", detail: "邮箱或密码不对。" },
  "account-disabled": { status: 403, code: "account_disabled", detail: "这个账号已停用，请联系管理员。" },
  // The same answer whether or not the address has an account (the lock is per address, not per user).
  locked: { status: 429, code: "rate_limited", detail: "尝试太频繁了，请稍后再试。" },
} as const;

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function registerAccounts(app: FastifyInstance) {
  // The register page asks which door this instance has (no secrets, no counts).
  app.get("/api/auth/registration", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const mode = registrationMode();
    return { mode, inviteRequired: mode === "invite" };
  });

  app.post("/api/auth/register", { config: { rateLimit: LIMITS.secret } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (limited(`auth:${req.ip}`)) {
      return sendProblem(req, reply, { status: 429, code: "rate_limited", detail: "尝试太频繁了，请一分钟后再试。", retryAfter: 60 });
    }
    const b = bodyOf(req);
    // A filled honeypot field (hidden from people, not from form-filling bots) is refused quietly.
    if (typeof b.website === "string" && b.website.trim() !== "") {
      return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "注册失败，请稍后再试。" });
    }
    const over = registerLimited(req.ip);
    if (over) {
      const detail = over === "client" ? "这一小时注册尝试太多了，请稍后再试。" : "现在注册的人太多了，请过一会儿再试。";
      return sendProblem(req, reply, { status: 429, code: "rate_limited", detail, retryAfter: over === "client" ? 3600 : 600 });
    }
    try {
      const { token, user } = await registerWithInvite({
        code: String(b.code ?? ""),
        email: String(b.email ?? ""),
        password: String(b.password ?? ""),
        userAgent: req.headers["user-agent"],
        ip: req.ip,
      });
      created.push(Date.now());
      noteRegisterTry(req.ip);
      setSessionCookie(reply, token);
      return { user: userBody(user) };
    } catch (error) {
      if (!(error instanceof RegisterRejected)) throw error;
      if (error.reason === "email-taken" || error.reason === "invite-invalid") noteRegisterTry(req.ip);
      const p = REGISTER_PROBLEMS[error.reason];
      return sendProblem(req, reply, { ...p, title: "Registration failed" });
    }
  });

  app.post("/api/auth/login", { config: { rateLimit: LIMITS.secret } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (limited(`auth:${req.ip}`)) {
      return sendProblem(req, reply, { status: 429, code: "rate_limited", detail: "尝试太频繁了，请一分钟后再试。", retryAfter: 60 });
    }
    const b = bodyOf(req);
    try {
      const { token, user } = await loginWithPassword({
        email: String(b.email ?? ""),
        password: String(b.password ?? ""),
        userAgent: req.headers["user-agent"],
        ip: req.ip,
      });
      setSessionCookie(reply, token);
      return { user: userBody(user) };
    } catch (error) {
      if (!(error instanceof LoginRejected)) throw error;
      const p = LOGIN_PROBLEMS[error.reason];
      return sendProblem(req, reply, { ...p, title: "Sign-in failed", ...(error.reason === "locked" ? { retryAfter: error.retryAfter ?? 60 } : {}) });
    }
  });

  app.get("/api/auth/me", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await resolveSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    return { user: userBody(user) };
  });

  // The reader's own settings: locale and/or IANA timezone for the daily issue's local 08:00 fix.
  // Changing either never rewrites an already-fixed issue row; the next fix follows the new zone.
  app.patch("/api/auth/me", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await resolveSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const b = bodyOf(req);
    const hasTimezone = "timezone" in b;
    const hasLocale = "locale" in b;
    if (!hasTimezone && !hasLocale) {
      return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "请提供 locale 或 timezone。" });
    }
    let timezone = user.timezone;
    let locale = user.locale;
    if (hasLocale) {
      const raw = typeof b.locale === "string" ? b.locale : "";
      if (!isValidLocale(raw)) {
        return sendProblem(req, reply, { status: 400, code: "invalid_locale", detail: "语言不对，只支持 zh-CN 或 en。", title: "Invalid locale" });
      }
      locale = raw;
    }
    if (hasTimezone) {
      const raw = typeof b.timezone === "string" ? b.timezone : "";
      if (!isValidTimeZone(raw)) {
        return sendProblem(req, reply, { status: 400, code: "invalid_timezone", detail: "时区名字不对，请用系统时区的名字（比如 Asia/Shanghai）。", title: "Invalid timezone" });
      }
      timezone = raw;
    }
    const [fresh] = await sql<{ id: string; email: string; displayName: string | null; locale: string; timezone: string; role: string }[]>`
      UPDATE users SET locale = ${locale}, timezone = ${timezone} WHERE id = ${user.id}
      RETURNING id, email, display_name AS "displayName", locale, timezone, role`;
    return { user: userBody(fresh!) };
  });

  // Both session kinds end here: the user's JSON clients and the admin's HTML form (a form post gets
  // the redirect the shell has always followed).
  app.post("/api/auth/logout", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const header = req.headers.cookie;
    if (parseCookies(header)[ADMIN_SESSION_COOKIE]) await endSession(header);
    await destroySession(parseCookies(header)[SESSION_COOKIE]);
    clearSessionCookies(reply);
    const formPost = String(req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
    if (formPost || String(req.headers.accept ?? "").includes("text/html")) return reply.redirect("/", 303);
    return { ok: true };
  });

  // Self-service account deletion: the user confirms the password, the account and everything owned by
  // it go (sessions cascade with the user row; projects and proposals too). A wrong password refuses
  // the whole thing — the session's user and password are checked independently, so a stolen cookie
  // cannot delete the account without the password.
  app.post("/api/auth/delete-account", { config: { rateLimit: LIMITS.secret } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await resolveSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    // Per account as well as per address: a stolen cookie must not become a password-guessing oracle.
    if (limited(`delete:${user.id}`)) {
      return sendProblem(req, reply, { status: 429, code: "rate_limited", detail: "尝试太频繁了，请一分钟后再试。", retryAfter: 60 });
    }
    const password = String(bodyOf(req).password ?? "");
    const [row] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${user.id}`;
    if (!row || !(await verifyPassword(row.password_hash, password))) {
      return sendProblem(req, reply, { status: 400, code: "wrong_password", detail: "密码不对，注销不了。" });
    }
    clearSessionCookies(reply);
    await sql`DELETE FROM users WHERE id = ${user.id}`;
    return { ok: true, message: "账号已经注销了。" };
  });
}
