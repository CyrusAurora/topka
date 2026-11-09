// Per-user model keys: a user's own OpenAI-compatible key, encrypted at rest
// with the instance master key (KEY_ENCRYPTION_SECRET, AES-256-GCM) and never echoed back — the
// API shows only the last four characters. The master key is a 32+ byte base64 string; without it
// per-user keys are disabled and storage is refused. The interactive/assistant path prefers the
// user's key over the instance's (resolveUserLlmKey), so the web chat never spends the instance
// budget on a person who brought their own.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.ts";
import { sql, type Db, type Sql } from "../db.ts";

const SECRET_BYTES = 32;

/** Derives the AES-256 key from the master secret (it is not itself key material). */
function keyOf(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function validSecret(): string | null {
  const secret = config.keyEncryptionSecret;
  if (!secret) return null;
  const decoded = Buffer.from(secret, "base64");
  if (decoded.length === SECRET_BYTES) return secret;
  // Not base64: take the raw bytes if they are long enough, otherwise it is not usable key material.
  const raw = Buffer.from(secret, "utf8");
  return raw.length >= SECRET_BYTES ? secret : null;
}

/** Local development and tests may point a key at a loopback model server; never in production. */
export function privateBaseUrlAllowed(): boolean {
  return config.allowPrivateNetworkFetch || process.env.BYOK_ALLOW_PRIVATE_BASE_URL === "true";
}

/**
 * A reader's Base URL is fetched by this server, so it must be a public https endpoint (SSRF guard:
 * no loopback, private, link-local or metadata address, by name or by DNS answer). Returns the reason
 * in plain words, or null when it is fine.
 */
export async function baseUrlProblem(raw: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Base URL 不是一个网址。";
  }
  const allowPrivate = privateBaseUrlAllowed();
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) return "Base URL 要用 https://。";
  if (u.username || u.password) return "Base URL 里不要带用户名或密码。";
  try {
    const { assertPublicUrl } = await import("../lib/url.ts");
    await assertPublicUrl(u.toString(), allowPrivate);
  } catch {
    return "Base URL 要是公网能访问的地址（不能是本机、内网或云厂商的元数据地址）。";
  }
  return null;
}

export class UserKeysUnavailableError extends Error {
  constructor() {
    super("user keys are not configured");
  }
}

export interface UserKeyRecord {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  last4: string;
  updatedAt: Date;
}

export interface UserLlmKey {
  provider: string;
  baseUrl: string;
  model: string | null;
  apiKey: string;
}

/** Ciphertext layout: 12-byte random IV || ciphertext body || 16-byte AES-GCM tag, one bytea value. */
export function encryptKey(plaintext: string, secret = config.keyEncryptionSecret!): Buffer {
  const master = keyOf(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

export function decryptKey(ciphertext: Buffer | Uint8Array | string, secret = config.keyEncryptionSecret!): string | null {
  const master = keyOf(secret);
  // postgres.js may hand back bytea as Buffer, Uint8Array, or a \x hex string depending on version.
  const buf = Buffer.isBuffer(ciphertext)
    ? ciphertext
    : typeof ciphertext === "string"
      ? Buffer.from(ciphertext.startsWith("\\x") ? ciphertext.slice(2) : ciphertext, ciphertext.startsWith("\\x") || /^[0-9a-f]+$/i.test(ciphertext) ? "hex" : "utf8")
      : Buffer.from(ciphertext);
  if (buf.length <= 12 + 16) return null;
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const body = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", master, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function keyLast4(plaintext: string): string {
  return plaintext.slice(-4);
}

const PROVIDER_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface Row {
  provider: string;
  base_url: string | null;
  model: string | null;
  key_ciphertext: Buffer;
  key_last4: string;
  updated_at: Date;
}

export function encryptionConfigured(): boolean {
  return validSecret() !== null;
}

/** The user's stored keys, last four characters only. */
export async function listKeys(userId: string, db: Db = sql): Promise<UserKeyRecord[]> {
  const rows = await db<Row[]>`SELECT provider, base_url, model, key_ciphertext, key_last4, updated_at FROM user_provider_keys WHERE user_id = ${userId} ORDER BY provider`;
  return rows.map((row) => ({
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    last4: row.key_last4,
    updatedAt: row.updated_at,
  }));
}

export interface UpsertKeyInput {
  apiKey: string;
  baseUrl?: string | null;
  model?: string | null;
}

export interface UpsertKeyResult {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  last4: string;
}

/** Stores or replaces one provider's key for the user. Refuses when the instance has no master key. */
export async function upsertKey(userId: string, provider: string, input: UpsertKeyInput, db: Sql = sql): Promise<UpsertKeyResult> {
  const secret = validSecret();
  if (!secret) throw new UserKeysUnavailableError();
  if (!PROVIDER_SHAPE.test(provider)) throw new Error(`bad provider ${provider}`);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("empty key");
  const baseUrl = input.baseUrl?.trim() || null;
  const model = input.model?.trim() || null;
  const ciphertext = encryptKey(apiKey, secret);
  const last4 = keyLast4(apiKey);
  await db`
    INSERT INTO user_provider_keys (user_id, provider, base_url, model, key_ciphertext, key_last4)
    VALUES (${userId}, ${provider}, ${baseUrl}, ${model}, ${ciphertext}, ${last4})
    ON CONFLICT (user_id, provider) DO UPDATE SET
      base_url = EXCLUDED.base_url, model = EXCLUDED.model,
      key_ciphertext = EXCLUDED.key_ciphertext, key_last4 = EXCLUDED.key_last4, updated_at = now()`;
  invalidateUserKeyCache();
  return { provider, baseUrl, model, last4 };
}

export async function deleteKey(userId: string, provider: string, db: Sql = sql): Promise<boolean> {
  const rows = await db`DELETE FROM user_provider_keys WHERE user_id = ${userId} AND provider = ${provider} RETURNING user_id`;
  if (rows.length) invalidateUserKeyCache();
  return rows.length > 0;
}

const keyCache = new Map<string, { at: number; value: UserLlmKey | null }>();

/** Clears the short resolve cache (upsert / delete keep it honest; the next read goes to the database). */
export function invalidateUserKeyCache(): void {
  keyCache.clear();
}

/**
 * The user's own key for the interactive path (BYOK: user → instance → fail): one row,
 * decrypted on read. The "llm" row wins; without one, the most recently saved key that has a base
 * URL serves (the settings form lets the reader name the provider freely). Cached for a minute;
 * upsertKey and deleteKey clear it. null: the user has no usable key, so the caller falls back to the
 * instance's own key.
 */
export async function resolveUserLlmKey(userId: string, provider = "llm", db: Db = sql): Promise<UserLlmKey | null> {
  if (!validSecret()) return null;
  const cacheKey = `${userId}:${provider}`;
  const hit = keyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const rows = await db<Row[]>`
    SELECT provider, base_url, model, key_ciphertext, key_last4, updated_at FROM user_provider_keys
    WHERE user_id = ${userId} AND (provider = ${provider} OR (${provider} = 'llm' AND base_url IS NOT NULL))
    ORDER BY (provider = ${provider}) DESC, updated_at DESC LIMIT 2`;
  let value: UserLlmKey | null = null;
  for (const row of rows) {
    const apiKey = decryptKey(row.key_ciphertext);
    if (apiKey && row.base_url) {
      value = { provider: row.provider, baseUrl: row.base_url, model: row.model, apiKey };
      break;
    }
  }
  keyCache.set(cacheKey, { at: Date.now(), value });
  return value;
}
