// Per-user model keys: AES-256-GCM round-trip of a stored key, the /api/me/keys
// door behind the session cookie, and the assistant's chat path preferring the user's own key over
// the instance's. Without KEY_ENCRYPTION_SECRET the storage is refused (503, in Chinese); with it,
// only the last four characters ever leave the database.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";
import {
  baseUrlProblem,
  decryptKey,
  encryptKey,
  keyLast4,
  listKeys,
  upsertKey,
  UserKeysUnavailableError,
} from "@topka/backend/accounts/user-keys";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
// The stubs below listen on loopback: allow it for this file except where the guard is under test.
process.env.BYOK_ALLOW_PRIVATE_BASE_URL = "true";
const MASTER = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");
const PASSWORD = `${T}-long-enough`;
const app = await buildApp();

// The instance's own model (the default path) and the user's BYOK endpoint; both answer the
// assistant's schema, the user's answer is tagged so a test can see which endpoint took the call.
const instanceModel = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  void body;
  const say = (o: unknown) => ({ id: "x", model: "stub", choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
  return say({ action: "reply", projectRef: null, reply: "实例 Key 答的。", proposal: null });
});
const userEndpoint = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  void body;
  const say = (o: unknown) => ({ id: "x", model: "user-key-model", choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
  return say({ action: "reply", projectRef: null, reply: "用自己的 Key 答的。", proposal: null });
});

let userId = "";
let userToken = "";

async function registerUser(email: string) {
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `test ${T}` })).code;
  return registerWithInvite({ code, email, password: PASSWORD, userAgent: "test", ip: "203.0.113.51" });
}

before(async () => {
  const r = await registerUser(`keys-${T}@example.com`);
  userId = r.user.id;
  userToken = r.token;
});

after(async () => {
  delete process.env.KEY_ENCRYPTION_SECRET;
  await instanceModel.close();
  await userEndpoint.close();
  await app.close();
  await closeDb();
});

test("encrypt/decrypt is a round trip; the plaintext never appears in the ciphertext", () => {
  const secret = MASTER;
  const ct = encryptKey("sk-abcdef-1234-SECRET", secret);
  assert.ok(!ct.toString("utf8").includes("sk-abcdef-1234-SECRET"), "the plaintext is not in the ciphertext");
  assert.equal(decryptKey(ct, secret), "sk-abcdef-1234-SECRET");
  // A different master key cannot read it: GCM tag mismatch.
  const other = Buffer.from("fedcba9876543210fedcba9876543210", "utf8").toString("base64");
  assert.equal(decryptKey(ct, other), null);
  assert.equal(keyLast4("sk-live-abcd"), "abcd");
});

test("without a master key storage is refused and nothing is written", async () => {
  delete process.env.KEY_ENCRYPTION_SECRET;
  await assert.rejects(
    () => upsertKey(userId, "llm", { apiKey: "sk-x", baseUrl: "https://x" }),
    (error: unknown) => error instanceof UserKeysUnavailableError,
  );
  assert.deepEqual(await listKeys(userId), [], "no rows without the master key");
  process.env.KEY_ENCRYPTION_SECRET = MASTER;
});

test("upsert stores the ciphertext and returns last4 only; a repeat upsert replaces the row", async () => {
  process.env.KEY_ENCRYPTION_SECRET = MASTER;
  const one = await upsertKey(userId, "llm", { apiKey: "sk-live-abcd", baseUrl: "https://user-ep", model: "user-key-model" });
  assert.deepEqual([one.provider, one.baseUrl, one.model, one.last4], ["llm", "https://user-ep", "user-key-model", "abcd"]);
  await upsertKey(userId, "llm", { apiKey: "sk-live-zzzz", baseUrl: "https://user-ep" });
  const keys = await listKeys(userId);
  assert.equal(keys.length, 1, "one row per provider, upserted");
  assert.equal(keys[0]!.last4, "zzzz", "the latest write wins");
  // The plaintext key is gone from the read path: only last4 and the encrypted blob exist.
  const [row] = await sql<{ key_ciphertext: Buffer }[]>`SELECT key_ciphertext FROM user_provider_keys WHERE user_id = ${userId} AND provider = 'llm'`;
  assert.ok(!row!.key_ciphertext.toString("utf8").includes("sk-live-zzzz"), "the clear key is not stored");
  assert.equal(decryptKey(row!.key_ciphertext, MASTER), "sk-live-zzzz", "but the stored blob decrypts");
});

test("the /api/me/keys door: list/put/delete behind sign-in, 503 when the instance has no master key", async () => {
  const cookie = `${SESSION_COOKIE}=${userToken}`;
  const anon = await app.inject({ method: "GET", url: "/api/me/keys" });
  assert.deepEqual([anon.statusCode, anon.json().detail], [401, "请先登录。"], anon.body);

  delete process.env.KEY_ENCRYPTION_SECRET;
  const put503 = await app.inject({ method: "PUT", url: "/api/me/keys/llm", headers: { "content-type": "application/json", cookie }, payload: JSON.stringify({ apiKey: "sk-1" }) });
  assert.deepEqual([put503.statusCode, put503.json().code, put503.json().detail], [503, "user_keys_disabled", put503.json().detail], put503.body);
  assert.match(put503.json().detail as string, /KEY_ENCRYPTION_SECRET|实例/);

  process.env.KEY_ENCRYPTION_SECRET = MASTER;
  const put = await app.inject({ method: "PUT", url: "/api/me/keys/llm", headers: { "content-type": "application/json", cookie }, payload: JSON.stringify({ apiKey: "sk-live-wxyz", baseUrl: "https://user-ep", model: "user-key-model" }) });
  assert.deepEqual(put.json(), { provider: "llm", baseUrl: "https://user-ep", model: "user-key-model", last4: "wxyz" }, put.body);
  const noKey = await app.inject({ method: "PUT", url: "/api/me/keys/llm", headers: { "content-type": "application/json", cookie }, payload: JSON.stringify({ baseUrl: "https://x" }) });
  assert.deepEqual([noKey.statusCode, noKey.json().code], [400, "api_key_required"], noKey.body);

  const list = await app.inject({ method: "GET", url: "/api/me/keys", headers: { cookie } });
  const body = list.json() as { keys: Array<{ provider: string; last4: string; baseUrl: string | null }>; encryptionConfigured: boolean };
  assert.equal(body.encryptionConfigured, true);
  assert.equal(body.keys.length, 1);
  assert.deepEqual([body.keys[0]!.provider, body.keys[0]!.last4, body.keys[0]!.baseUrl], ["llm", "wxyz", "https://user-ep"]);
  assert.ok(JSON.stringify(body).includes("sk-live-wxyz") === false, "the plaintext key never leaves");

  const del = await app.inject({ method: "DELETE", url: "/api/me/keys/llm", headers: { cookie } });
  assert.equal(del.json().ok, true, del.body);
  const gone = await app.inject({ method: "DELETE", url: "/api/me/keys/llm", headers: { cookie } });
  assert.equal(gone.statusCode, 404, gone.body);
});

// --- the assistant's chat path prefers the user's key ---

test("chatJson with a user's key hits the user's endpoint, not the instance's model", async () => {
  process.env.KEY_ENCRYPTION_SECRET = MASTER;
  Object.assign(process.env, {
    LLM_BASE_URL: `${instanceModel.url}/v1`,
    LLM_API_KEY: "test",
    LLM_MODEL: "stub-model",
    ASSISTANT_DAILY_TURNS: "40",
    MODEL_CALLS_ENABLED: "true",
  });
  await upsertKey(userId, "llm", { apiKey: "sk-live-wxyz", baseUrl: userEndpoint.url, model: "user-key-model" });
  const { chatJson } = await import("@topka/backend/providers/llm");
  const { z } = await import("zod");
  const schema = z.object({ action: z.literal("reply"), reply: z.string() });
  const res = await chatJson({
    model: "default", purpose: "invariant_test", subject: `uk:${T}`, promptVersion: "t1", system: "s", user: `u ${T}`,
    schema, userId,
  });
  assert.deepEqual(res.data, { action: "reply", reply: "用自己的 Key 答的。" }, "the user's endpoint answered");
  assert.equal(instanceModel.hits(), 0, "the instance's key was not touched");
});

test("the Base URL guard: public https only; loopback, private, metadata and credentials are refused", async () => {
  process.env.BYOK_ALLOW_PRIVATE_BASE_URL = "false";
  try {
    assert.match(String(await baseUrlProblem("http://93.184.215.14/v1")), /https/);
    for (const bad of ["https://127.0.0.1:3001/v1", "https://localhost/v1", "https://169.254.169.254/latest", "https://10.0.0.8/v1", "https://[::1]/v1", "https://svc.internal/v1"]) {
      assert.ok(await baseUrlProblem(bad), `${bad} is refused`);
    }
    assert.match(String(await baseUrlProblem("https://u:p@93.184.215.14/v1")), /用户名或密码/);
    assert.match(String(await baseUrlProblem("not a url")), /网址/);
    assert.equal(await baseUrlProblem("https://93.184.215.14/v1"), null, "a public literal address passes");

    process.env.KEY_ENCRYPTION_SECRET = MASTER;
    const cookie = `${SESSION_COOKIE}=${userToken}`;
    const put = await app.inject({ method: "PUT", url: "/api/me/keys/llm", headers: { "content-type": "application/json", cookie }, payload: JSON.stringify({ apiKey: "sk-ssrf-0000", baseUrl: "http://127.0.0.1:3001/api" }) });
    assert.deepEqual([put.statusCode, put.json().code], [400, "bad_base_url"], put.body);

    // A key stored before the guard (written straight to the table) is refused at call time, unsent.
    const hitsBefore = userEndpoint.hits();
    await upsertKey(userId, "llm", { apiKey: "sk-old-1111", baseUrl: userEndpoint.url, model: "user-key-model" });
    const { chatJson } = await import("@topka/backend/providers/llm");
    const { z } = await import("zod");
    await assert.rejects(() => chatJson({
      model: "default", purpose: "invariant_test", subject: `uk-guard:${T}`, promptVersion: "t1", system: "s", user: `g ${T}`,
      schema: z.object({ action: z.literal("reply"), reply: z.string() }), userId,
    }), /user base URL refused/);
    assert.equal(userEndpoint.hits(), hitsBefore, "nothing reached the loopback endpoint");
  } finally {
    process.env.BYOK_ALLOW_PRIVATE_BASE_URL = "true";
  }
});

test("the BYOK call dials through the guarded lookup: a name that resolves to loopback is refused at connect time", async () => {
  const { guardedDirectDispatcher, undiciFetch } = await import("@topka/backend/lib/http-fetch");
  const before = userEndpoint.hits();
  const port = new URL(userEndpoint.url).port;
  await assert.rejects(() => undiciFetch(`http://localhost:${port}/chat/completions`, { method: "POST", body: "{}", dispatcher: guardedDirectDispatcher() }), (e: Error) => /EBLOCKED|Blocked/.test(String((e as { cause?: unknown }).cause ?? e)));
  assert.equal(userEndpoint.hits(), before, "nothing reached the loopback endpoint");
});
