// 来源健康报表（设计书 3.4/第 4 章覆盖维度）：登录可见的采集健康总览——
// 每个已启用来源的最近成功/失败、连续失败计数与健康态，以及按标签（batch-1 家族）的汇总。
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseCookies } from "@topka/backend/admin/auth";
import { resolveSession, SESSION_COOKIE } from "@topka/backend/accounts/session";
import { sql } from "@topka/backend/db";
import { sendProblem } from "../http/respond.ts";

async function sessionOf(req: FastifyRequest) {
  return resolveSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

export function registerSourceHealth(app: FastifyInstance) {
  app.get("/api/sources/health", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });

    const sources = await sql`
      SELECT id, name, kind, tags, health, fail_count,
             last_ok_at, last_fetch_at, last_error, enabled
      FROM sources
      WHERE enabled AND 'batch-1' = ANY (tags)
      ORDER BY (last_ok_at IS NULL), last_ok_at DESC NULLS LAST, name
    `;
    const rows = sources.map((s: Record<string, unknown>) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      family: ((s.tags as string[] | null) ?? []).includes("directory") ? "directory"
        : (s.tags as string[] | null)?.includes("weibo") ? "weibo" : "rss",
      health: s.health,
      failCount: s.fail_count,
      lastOkAt: s.last_ok_at ?? null,
      lastFetchAt: s.last_fetch_at ?? null,
      lastError: s.last_error ?? null,
    }));

    const byHealth: Record<string, number> = { ok: 0, degraded: 0, failing: 0, unknown: 0, paused: 0 };
    for (const r of rows) {
      const h = String(r.health);
      byHealth[h] = (byHealth[h] ?? 0) + 1;
    }

    return { total: rows.length, byHealth, sources: rows };
  });
}
