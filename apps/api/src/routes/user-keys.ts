// Per-user model keys: the instance master key encrypts each user's own
// OpenAI-compatible key (AES-256-GCM); the API lists and deletes keys by last four characters
// only and refuses to store when KEY_ENCRYPTION_SECRET is absent. The assistant's chat path
// prefers a user's key over the instance's (llm.ts userKeyRoute); article analysis stays
// instance-only.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseCookies } from "@topka/backend/admin/auth";
import { resolveSession, SESSION_COOKIE } from "@topka/backend/accounts/session";
import {
  deleteKey,
  baseUrlProblem,
  encryptionConfigured,
  listKeys,
  upsertKey,
  UserKeysUnavailableError,
} from "@topka/backend/accounts/user-keys";
import { modelStatus } from "@topka/backend/providers/availability";
import { sendProblem } from "../http/respond.ts";

async function sessionOf(req: FastifyRequest) {
  return resolveSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function registerUserKeys(app: FastifyInstance) {
  // Who would answer the reader's chat right now (their key, the instance, nobody) and why not; the
  // chat page and 设置 show it. Configuration only: no model call, no key material.
  app.get("/api/me/model-status", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    return modelStatus(user.id);
  });

  app.get("/api/me/keys", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    return { keys: await listKeys(user.id), encryptionConfigured: encryptionConfigured() };
  });

  app.put("/api/me/keys/:provider", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const provider = String((req.params as { provider?: string }).provider ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(provider)) {
      return sendProblem(req, reply, { status: 400, code: "bad_provider", detail: "provider 只能是字母、数字、连字符，最多 63 位。" });
    }
    const b = bodyOf(req);
    const apiKey = String(b.apiKey ?? "");
    if (!apiKey) return sendProblem(req, reply, { status: 400, code: "api_key_required", detail: "请填你的模型 Key。" });
    const baseUrl = b.baseUrl !== undefined && b.baseUrl !== null && String(b.baseUrl).trim() ? String(b.baseUrl).trim() : null;
    if (baseUrl) {
      const problem = await baseUrlProblem(baseUrl);
      if (problem) return sendProblem(req, reply, { status: 400, code: "bad_base_url", detail: problem });
    }
    try {
      const saved = await upsertKey(user.id, provider, {
        apiKey,
        baseUrl,
        model: b.model !== undefined && b.model !== null ? String(b.model) : null,
      });
      return { ...saved };
    } catch (error) {
      if (error instanceof UserKeysUnavailableError) {
        return sendProblem(req, reply, { status: 503, code: "user_keys_disabled", detail: "这个实例没开放「自带 Key」：请改用实例的模型，或让管理员设置 KEY_ENCRYPTION_SECRET。" });
      }
      if (error instanceof Error && /bad provider|empty key/.test(error.message)) {
        return sendProblem(req, reply, { status: 400, code: "bad_input", detail: "Key 或 provider 不对，请检查一下再存。" });
      }
      throw error;
    }
  });

  app.delete("/api/me/keys/:provider", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const provider = String((req.params as { provider?: string }).provider ?? "");
    const removed = await deleteKey(user.id, provider);
    if (!removed) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个 provider 的 Key。" });
    return { ok: true };
  });
}
