// Scrubs a copy of the database (a staging site, a restore drill) of everything that identifies a
// person or opens an account: emails, names, password hashes, sessions, stored model keys, WeChat ids,
// invitation codes, feedback and chat text, delivery payloads. Content (articles, sources, issues,
// projects) is kept, so the copy behaves like the real site. Every account gets one known password,
// so the copy can be signed into. docs/operations.md → Staging.
import { hashPassword } from "../accounts/password.ts";
import type { Db, Tx } from "../db.ts";

/** Where a database name has to point before anything is scrubbed: never the live database by mistake. */
export const SCRUB_DB_NAME = /(staging|restore|drill|scratch|_ci|_test)/i;

export type ScrubReport = Record<string, number>;

export async function anonymize(db: Db, opts: { password: string }): Promise<ScrubReport> {
  if (opts.password.length < 10) throw new Error("anonymize: the shared password needs at least 10 characters");
  const [{ name }] = await db<{ name: string }[]>`SELECT current_database() AS name`;
  if (!SCRUB_DB_NAME.test(name)) throw new Error(`anonymize: refusing database "${name}" (its name must say staging, restore, drill, scratch, _ci or _test)`);
  const hash = await hashPassword(opts.password);
  const report: ScrubReport = {};
  const count = (key: string, rows: { count: number }) => { report[key] = rows.count; };

  // Two passes, so a new address never collides with an old one still in the table.
  await db`UPDATE users SET email = id || '@scrub.invalid'`;
  count("users", await db`
    UPDATE users u SET email = 'user-' || x.n || '@example.com', password_hash = ${hash},
           display_name = CASE WHEN u.display_name IS NULL THEN NULL ELSE 'User ' || x.n END
    FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM users) x WHERE u.id = x.id`);
  await db`UPDATE admin_users SET email = id || '@scrub.invalid', feishu_union_id = NULL`;
  count("admin_users", await db`
    UPDATE admin_users a SET email = 'admin-' || x.n || '@example.com',
           display_name = CASE WHEN a.display_name IS NULL THEN NULL ELSE 'Admin ' || x.n END
    FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM admin_users) x WHERE a.id = x.id`);

  // Sign-ins, one-time codes and secrets: nothing on the copy may still open the real accounts.
  for (const t of ["sessions", "admin_sessions", "email_verifications", "login_throttle", "mp_bind_codes", "user_provider_keys"] as const) {
    count(t, await db`DELETE FROM ${db(t)}`);
  }
  count("user_issue_feeds", await db`UPDATE user_issue_feeds SET token_hash = encode(gen_random_bytes(32), 'hex')`);
  count("invitations", await db`UPDATE invitations SET code = 'staging-' || encode(gen_random_bytes(8), 'hex'), note = NULL`);
  count("mp_identities", await db`
    UPDATE mp_identities m SET openid = 'staging-openid-' || x.n FROM (SELECT openid, row_number() OVER (ORDER BY bound_at, openid) AS n FROM mp_identities) x
    WHERE m.openid = x.openid`);

  // What people wrote, and where messages went.
  count("feedback", await db`UPDATE feedback SET content = '[redacted]', email = NULL, page_url = NULL, screenshot_key = NULL, note = NULL, forward_error = NULL`);
  count("assistant_turns", await db`UPDATE assistant_turns SET user_text = '[redacted]', reply_text = '[redacted]'`);
  count("deliveries", await db`UPDATE deliveries SET target_key = 'staging', payload = '{}'::jsonb, response = NULL`);
  count("notify_targets", await db`
    UPDATE notify_targets n SET key = 'staging-target-' || x.n, enabled = false, config_ref = NULL, note = NULL
    FROM (SELECT key, row_number() OVER (ORDER BY key) AS n FROM notify_targets) x WHERE n.key = x.key`);
  count("settings", await db`DELETE FROM settings WHERE key LIKE 'alerts.webhook%'`);

  // Who did what: the audit log and every "…_by" / actor column hold operator addresses.
  count("audit_log", await db`
    UPDATE audit_log SET actor = regexp_replace(actor, ${EMAIL}, 'operator@example.com', 'g'),
           subject = regexp_replace(subject, ${EMAIL}, 'someone@example.com', 'g'),
           reason = regexp_replace(reason, ${EMAIL}, 'someone@example.com', 'g'),
           before = regexp_replace(before::text, ${EMAIL}, 'someone@example.com', 'g')::jsonb,
           after = regexp_replace(after::text, ${EMAIL}, 'someone@example.com', 'g')::jsonb
    WHERE concat_ws(' ', actor, subject, reason, before::text, after::text) ~ ${EMAIL}`);
  for (const { table, column } of await actorColumns(db)) {
    if (table === "audit_log") continue;
    const [{ n }] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM ${db(table)} WHERE ${db(column)}::text ~ ${EMAIL}`;
    if (!n) continue;
    // Append-only tables refuse the update; what stays there is reported by personalDataLeft.
    await savepoint(db, (sp) => sp`UPDATE ${sp(table)} SET ${sp(column)} = 'operator@example.com' WHERE ${sp(column)}::text ~ ${EMAIL}`)
      .then(() => { report[`${table}.${column}`] = n; }, () => { report[`${table}.${column} (append-only, kept)`] = n; });
  }
  return report;
}

const EMAIL = "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\\.[A-Za-z0-9.-]*[a-z]{2,}";

async function actorColumns(db: Db): Promise<{ table: string; column: string }[]> {
  return db<{ table: string; column: string }[]>`
    SELECT table_name AS table, column_name AS column FROM information_schema.columns
    WHERE table_schema = current_schema() AND data_type IN ('text', 'USER-DEFINED') AND column_name ~ '(_by|actor)$'
    ORDER BY 1, 2`;
}

function savepoint(db: Db, fn: (sp: Db) => Promise<unknown>): Promise<unknown> {
  return "savepoint" in db ? (db as Tx).savepoint((sp) => fn(sp)) : fn(db);
}

/** What a scrubbed copy must not hold; an empty list means clean. Checked after every anonymize run. */
export async function personalDataLeft(db: Db): Promise<string[]> {
  const left: string[] = [];
  const [c] = await db<{ users: number; admins: number; secrets: number; feedback: number; turns: number }[]>`
    SELECT (SELECT count(*)::int FROM users WHERE email::text !~ '^user-[0-9]+@example\\.com$') AS users,
           (SELECT count(*)::int FROM admin_users WHERE email::text !~ '^admin-[0-9]+@example\\.com$' OR feishu_union_id IS NOT NULL) AS admins,
           (SELECT count(*)::int FROM sessions) + (SELECT count(*)::int FROM admin_sessions) + (SELECT count(*)::int FROM user_provider_keys)
             + (SELECT count(*)::int FROM email_verifications) + (SELECT count(*)::int FROM mp_bind_codes) AS secrets,
           (SELECT count(*)::int FROM feedback WHERE content <> '[redacted]' OR email IS NOT NULL) AS feedback,
           (SELECT count(*)::int FROM assistant_turns WHERE user_text <> '[redacted]' OR reply_text <> '[redacted]') AS turns`;
  if (c.users) left.push(`${c.users} user email(s) not scrubbed`);
  if (c.admins) left.push(`${c.admins} admin account(s) not scrubbed`);
  if (c.secrets) left.push(`${c.secrets} session(s), key(s) or code(s) left`);
  if (c.feedback) left.push(`${c.feedback} feedback row(s) not redacted`);
  if (c.turns) left.push(`${c.turns} chat turn(s) not redacted`);
  // Any address left in the tables people write to (content tables may quote addresses; they are public).
  const columns: Array<readonly [string, string]> = [["deliveries", "target_key"], ["notify_targets", "key"], ["mp_identities", "openid"], ["settings", "value"],
    ["audit_log", "subject"], ["audit_log", "reason"], ["audit_log", "before"], ["audit_log", "after"],
    ...(await actorColumns(db)).map((c) => [c.table, c.column] as const)];
  for (const [table, column] of columns) {
    const [{ n }] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${db(table)} WHERE ${db(column)}::text ~ ${EMAIL} AND ${db(column)}::text !~ '@example\\.com'`;
    if (n) left.push(`${table}.${column}: ${n} row(s) with an email address`);
  }
  return left;
}
