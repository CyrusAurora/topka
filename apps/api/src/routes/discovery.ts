// Discovery channels and pending-evidence signals (master design 2.2 /discover, 3.2; docs/discovery.md).
// Reader side (behind the session, decision D10): GET /api/discover — the directory catalog, the
// pending list (directory signals plus the caller's own projects' signals, folded, newest first, at
// most 20) and the promotion lineage; per project (owner only, 404 to anyone else):
// GET/POST /api/projects/:projectId/signals and POST …/signals/:signalId/dismiss. A lead is stored
// even when its URL has no identity (shown, never promoted). Operator side: GET /api/admin/discovery,
// dismiss/restore one signal, run the channels and the gate now, and the feed count.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveSession, SESSION_COOKIE } from "@topka/backend/accounts/session";
import { parseCookies, actorOf, audit } from "@topka/backend/admin/auth";
import { listOwnedProjects, requireProjectOwner } from "@topka/backend/publication/project-owner";
import {
  LeadRejected, addLead, adminSignals, collectDiscoveryChannels, directoryCatalog, discoverySettings, dismissSignal,
  pendingSignals, promotions, restoreSignal, runPromotionGate, saveDiscoverySettings,
} from "@topka/backend/discovery/signals";
import { sendProblem } from "../http/respond.ts";
import { LIMITS } from "../http/rate-limit.ts";
import { adminHandler } from "./admin-auth.ts";
import { projectIdSegment } from "./projects.ts";

const LEAD_DETAIL: Record<LeadRejected["code"], string> = {
  "url-required": "线索要带一个链接。",
  "too-long": "链接、标题或备注太长了。",
  "too-many": "这个项目的待证线索已经太多，先处理一些再加。",
};

const sessionOf = (req: FastifyRequest) => resolveSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
const bodyOf = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

async function ownedProject(req: FastifyRequest) {
  const user = await sessionOf(req);
  if (!user) return null;
  const projectId = projectIdSegment(String((req.params as { projectId?: string }).projectId ?? ""));
  if (!projectId) return null;
  const access = await requireProjectOwner(user.id, projectId);
  return access.kind === "ok" ? { user, project: access.project } : null;
}

export function registerDiscovery(app: FastifyInstance) {
  app.get("/api/discover", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const projects = await listOwnedProjects(user.id);
    const scope = { kind: "site" as const, projectIds: projects.map((p) => p.id) };
    const [catalog, pending, promoted] = await Promise.all([directoryCatalog(), pendingSignals(scope), promotions(scope)]);
    return { catalog, pending, promoted, projects: projects.map((p) => ({ id: p.id, slug: p.slug, target: p.target })) };
  });

  app.get("/api/projects/:projectId/signals", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const owned = await ownedProject(req);
    if (!owned) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个项目。" });
    const scope = { kind: "project" as const, projectId: owned.project.id };
    const [pending, promoted] = await Promise.all([pendingSignals(scope), promotions(scope)]);
    return { pending, promoted };
  });

  app.post("/api/projects/:projectId/signals", { config: { rateLimit: LIMITS.lead } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const owned = await ownedProject(req);
    if (!owned) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个项目。" });
    try {
      const result = await addLead(owned.project.id, owned.user.id, bodyOf(req));
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof LeadRejected) return sendProblem(req, reply, { status: 400, code: error.code.replaceAll("-", "_"), detail: LEAD_DETAIL[error.code] });
      throw error;
    }
  });

  app.post("/api/projects/:projectId/signals/:signalId/dismiss", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const owned = await ownedProject(req);
    if (!owned) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个项目。" });
    const signalId = String((req.params as { signalId?: string }).signalId ?? "");
    const signal = await dismissSignal(signalId, `user:${owned.user.id}`, String(bodyOf(req).reason ?? ""), { projectId: owned.project.id });
    if (!signal) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这条待证线索。" });
    return { signal };
  });

  // Operator ------------------------------------------------------------------------------------
  app.get("/api/admin/discovery", adminHandler(async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return adminSignals({ status: q.status, kind: q.kind, page: Number(q.page) || 1 });
  }));
  app.post("/api/admin/discovery/:id/dismiss", adminHandler(async (req, reply, admin) => {
    const id = (req.params as { id: string }).id;
    const reason = String(bodyOf(req).reason ?? "").trim();
    if (!reason) return sendProblem(req, reply, { status: 400, code: "reason_required", detail: "A reason is required." });
    const signal = await dismissSignal(id, actorOf(admin), reason);
    if (!signal) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "Not found." });
    await audit(actorOf(admin), "discovery.dismiss", `signal:${id}`, reason, { status: "awaiting" }, { status: "dismissed" });
    return { signal };
  }));
  app.post("/api/admin/discovery/:id/restore", adminHandler(async (req, reply, admin) => {
    const id = (req.params as { id: string }).id;
    const signal = await restoreSignal(id);
    if (!signal) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "Not found." });
    await audit(actorOf(admin), "discovery.restore", `signal:${id}`, null, { status: "dismissed" }, { status: "awaiting" });
    return { signal };
  }));
  app.post("/api/admin/discovery/run", adminHandler(async (req, _reply, admin) => {
    const gateOnly = bodyOf(req).gateOnly === true;
    const result = gateOnly ? { gate: await runPromotionGate() } : await collectDiscoveryChannels();
    await audit(actorOf(admin), gateOnly ? "discovery.gate" : "discovery.run", "settings:discovery", null, null, result);
    return result;
  }));
  app.put("/api/admin/discovery/settings", adminHandler(async (req, _reply, admin) => {
    const before = await discoverySettings();
    const after = await saveDiscoverySettings({ feedCount: bodyOf(req).feedCount }, actorOf(admin));
    await audit(actorOf(admin), "settings.discovery", "settings:discovery", null, before, after);
    return after;
  }));
}
