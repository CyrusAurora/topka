// Staging and drill tools (docs/operations.md): the anonymizer leaves no personal data and one known
// password, the fingerprint sees any change, the mock webhook records what the alerts send.
import "./setup.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { verifyPassword } from "@topka/backend/accounts/password";
import { anonymize, personalDataLeft, SCRUB_DB_NAME } from "@topka/backend/operations/anonymize";
import { compareFingerprints, fingerprint } from "@topka/backend/operations/fingerprint";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(path.join(tmpdir(), "staging-tools-"));
const T = Date.now().toString(36);
class Rollback extends Error {}
after(async () => { rmSync(tmp, { recursive: true, force: true }); await closeDb(); });

test("only a copy is scrubbed: the database name has to say so, and the password has to be real", async () => {
  for (const ok of ["topka_staging", "restore_20261117", "drill_x", "a_ci", "b_test", "Scratch"]) assert.match(ok, SCRUB_DB_NAME);
  for (const no of ["topka", "production", "prod", "topka_live"]) assert.doesNotMatch(no, SCRUB_DB_NAME);
  await assert.rejects(sql.begin((tx) => anonymize(tx, { password: "short" })), /at least 10/);
});

test("anonymize: no address, name, session, key, code or written text survives; every account opens with the one password", async () => {
  const u = `scrub-${T}`;
  await assert.rejects(sql.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash, display_name, locale) VALUES (${u}, ${`real.person.${T}@gmail.com`}, 'x', 'Real Person', 'zh-CN')`;
    await tx`INSERT INTO sessions (id, user_id, expires_at) VALUES (${`s-${T}`}, ${u}, now() + interval '1 day')`;
    await tx`INSERT INTO user_provider_keys (user_id, key_ciphertext, key_last4) VALUES (${u}, '\\x00', '1234')`;
    await tx`INSERT INTO mp_identities (openid, user_id, bound_at) VALUES (${`oReal${T}`}, ${u}, now())`;
    await tx`INSERT INTO admin_users (email, display_name, feishu_union_id) VALUES (${`boss.${T}@company.cn`}, 'Boss', ${`on_${T}`})`;
    await tx`INSERT INTO feedback (content, email, source_hash) VALUES (${`my phone is 138-${T}`}, ${`fb.${T}@qq.com`}, 'h')`;
    await tx`INSERT INTO assistant_turns (user_id, user_text, reply_text) VALUES (${u}, '跟踪我前公司的裁员', '好的')`;
    await tx`INSERT INTO audit_log (actor, action, subject, after) VALUES (${`ops.${T}@company.cn`}, 'user.update', ${`real.person.${T}@gmail.com`}, ${tx.json({ email: `real.person.${T}@gmail.com` })})`;
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${`scrub.${T}`}, ${tx.json({ x: 1 })}, ${`ops.${T}@company.cn`})`;

    const report = await anonymize(tx, { password: "staging-password-1" });
    assert.ok(report.users >= 1 && report.sessions >= 1 && report.user_provider_keys >= 1, JSON.stringify(report));
    assert.deepEqual(await personalDataLeft(tx), []);

    const [user] = await tx<{ email: string; display_name: string; password_hash: string }[]>`SELECT email::text, display_name, password_hash FROM users WHERE id = ${u}`;
    assert.match(user.email, /^user-\d+@example\.com$/);
    assert.match(user.display_name, /^User \d+$/);
    assert.equal(await verifyPassword(user.password_hash, "staging-password-1"), true);
    const dump = JSON.stringify(await tx`
      SELECT (SELECT json_agg(a) FROM admin_users a) AS admins, (SELECT json_agg(f) FROM feedback f) AS feedback,
             (SELECT json_agg(t) FROM assistant_turns t) AS turns, (SELECT json_agg(l) FROM audit_log l) AS audit,
             (SELECT json_agg(s) FROM settings s WHERE key = ${`scrub.${T}`}) AS settings, (SELECT json_agg(m) FROM mp_identities m) AS mp`);
    for (const secret of [`real.person.${T}`, `boss.${T}`, `on_${T}`, `fb.${T}`, `ops.${T}`, `oReal${T}`, `138-${T}`, "裁员", "Real Person"]) {
      assert.ok(!dump.includes(secret), `${secret} survived`);
    }
    throw new Rollback(); // the shared test database keeps its rows
  }), Rollback);
});

test("personalDataLeft names what is still there", async () => {
  await assert.rejects(sql.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash, locale) VALUES (${`left-${T}`}, ${`left.${T}@gmail.com`}, 'x', 'en')`;
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${`left.${T}`}, ${tx.json({})}, ${`ops.${T}@company.cn`})`;
    const left = await personalDataLeft(tx);
    assert.ok(left.some((l) => /user email/.test(l)), left.join("; "));
    assert.ok(left.some((l) => /^settings\.updated_by/.test(l)), left.join("; "));
    throw new Rollback();
  }), Rollback);
});

test("fingerprint: equal for the same data, and any changed value or row shows", async () => {
  const tables = ["settings", "users"];
  const a = await fingerprint(sql, { tables });
  assert.deepEqual(compareFingerprints(a, await fingerprint(sql, { tables })), []);
  await assert.rejects(sql.begin(async (tx) => {
    await tx`INSERT INTO settings (key, value) VALUES (${`fp.${T}`}, ${tx.json({ a: 1 })})`;
    const b = await fingerprint(tx, { tables });
    assert.deepEqual(compareFingerprints(a, b), [`settings: ${a.settings.rows} rows vs ${a.settings.rows + 1}`]);
    await tx`UPDATE settings SET value = ${tx.json({ a: 2 })} WHERE key = ${`fp.${T}`}`;
    const c = await fingerprint(tx, { tables });
    assert.deepEqual(compareFingerprints(b, c), [`settings: same ${b.settings.rows} rows, different content`]);
    throw new Rollback();
  }), Rollback);
  assert.deepEqual(compareFingerprints({ x: { rows: 1, checksum: "a" } }, {}), ["x: only in the first"]);
});

test("scripts: anonymize needs its password, db-fingerprint --compare exits 1 on a difference", async () => {
  await assert.rejects(run(process.execPath, [path.join(ROOT, "scripts/anonymize.ts")], { env: { ...process.env, STAGING_PASSWORD: "" } }), (e: { code?: number }) => e.code === 2);
  const fp = path.join(ROOT, "scripts/db-fingerprint.ts");
  const a = path.join(tmp, "a.json"), b = path.join(tmp, "b.json");
  await run(process.execPath, [fp, "--out", a, "--table", "settings"], { env: process.env });
  await run(process.execPath, [fp, "--out", b, "--table", "settings"], { env: process.env });
  assert.match((await run(process.execPath, [fp, "--compare", a, b])).stdout, /equal \(1 tables\)/);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(b, JSON.stringify({ settings: { rows: -1, checksum: "changed" } }));
  await assert.rejects(run(process.execPath, [fp, "--compare", a, b]), (e: { code?: number; stdout?: string }) => e.code === 1 && /differ/.test(e.stdout ?? ""));
});

test("mock webhook: records what an alert sends, answers like Feishu, and can refuse the first N", async () => {
  const out = path.join(tmp, "hook.jsonl");
  const child = spawn(process.execPath, [path.join(ROOT, "scripts/mock-webhook.ts"), "--out", out, "--fail", "1"], { stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (d) => { const m = /listening (\S+)/.exec(String(d)); if (m) resolve(m[1]); });
    child.on("exit", () => reject(new Error("mock-webhook exited")));
  });
  try {
    const send = (text: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msg_type: "text", content: { text } }) });
    assert.equal((await send("first")).status, 500);
    const ok = await send("🔴 很多信源连续抓取失败");
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { code: 0, msg: "success" });
    const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.status, l.text]), [[500, "first"], [200, "🔴 很多信源连续抓取失败"]]);
  } finally {
    child.kill("SIGTERM");
  }
});
