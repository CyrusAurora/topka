// The project endpoints (master design 3.4/8.2 step 3, journey J2): the curated pack catalog, project
// creation, the caller's own project list, a single project and the pack preferences. Everything is
// behind the session; a project addressed by id answers 404 to anyone but its owner — anonymous or
// not — because existence is never leaked (8.1 isolation).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ProjectRejected, createProject } from "@topka/backend/projects/create-project";
import { UnknownSourcesError } from "@topka/backend/projects/bind-sources";
import { listSourcePacks } from "@topka/backend/projects/packs";
import { loadPackPrefs, savePackPrefs } from "@topka/backend/projects/pack-prefs";
import { resolveSession, SESSION_COOKIE } from "@topka/backend/accounts/session";
import { requireProjectOwner, listOwnedProjects } from "@topka/backend/publication/project-owner";
import { parseCookies } from "@topka/backend/admin/auth";
import { sendProblem, sendTextWithEtag } from "../http/respond.ts";
import { disableIssueFeed, issueFeedPath, issueFeedState, issueFeedXml, rotateIssueFeed, userForIssueFeed } from "@topka/backend/projects/issue-feed";
import { siteUrl } from "@topka/backend/publication/links";
import { AckRejected, acknowledgeToday, buildToday } from "@topka/backend/projects/today";
import { acknowledgeUserToday, markItem } from "@topka/backend/projects/user-today";
import { buildUserIssue, isIssueDate, issueCount, listPastIssues, readIssue, recordOpened } from "@topka/backend/projects/issues";
import { sql } from "@topka/backend/db";

/** The empty-goal refusal, verbatim from the handover's guided creation. */
const GOAL_PURPOSE_REQUIRED = "目标和方向都要有，回去补一句描述再来。";

const SEGMENT = /^[A-Za-z0-9._~:%-]{1,256}$/;

/** The project id route segment rule (master design 2.1): a narrow charset, no broken % escapes,
 *  no control characters once decoded. Anything else reads as not-found. */
export function projectIdSegment(raw: string): string | null {
  // The router hands over the segment decoded: a derived id sent as-is ("project:%E5…") arrives as
  // "project:具…". Re-encoding each part restores the stored form, so no client has to double-encode.
  // The short slug ("p" + 12 hex) needs none of this.
  const projectId = SEGMENT.test(raw) ? raw : raw.split(":").map((part) => encodeURIComponent(part)).join(":");
  if (!SEGMENT.test(projectId)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(projectId);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
  return projectId;
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

async function sessionOf(req: FastifyRequest) {
  return resolveSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

async function ownedProject(req: FastifyRequest) {
  const user = await sessionOf(req);
  if (!user) return null;
  const projectId = projectIdSegment(String((req.params as { projectId?: string }).projectId ?? ""));
  if (!projectId) return null;
  const access = await requireProjectOwner(user.id, projectId);
  return access.kind === "ok" ? access.project : null;
}

export function registerProjects(app: FastifyInstance) {
  // The pack catalog behind sign-in: the product face is private (decision D10).
  app.get("/api/packs", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    return { packs: await listSourcePacks() };
  });

  app.post("/api/projects", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const b = bodyOf(req);
    const sourceIds = Array.isArray(b.sourceIds) ? b.sourceIds.map(String) : [];
    try {
      const { project, created } = await createProject({ ownerId: user.id, target: String(b.target ?? ""), purpose: String(b.purpose ?? ""), sources: sourceIds.map((sourceId) => ({ sourceId, required: false })) });
      return reply.code(created ? 201 : 200).send({ project: { id: project.id, slug: project.slug, target: project.target, purpose: project.purpose, status: project.status, currentRevision: project.currentRevision, createdAt: project.createdAt } });
    } catch (error) {
      if (error instanceof ProjectRejected) {
        return sendProblem(req, reply, { status: 400, code: "goal_or_purpose_required", detail: GOAL_PURPOSE_REQUIRED, title: "Project rejected" });
      }
      if (error instanceof UnknownSourcesError) {
        return sendProblem(req, reply, { status: 400, code: "unknown_sources", detail: "所选来源不存在，请返回上一步重新勾选。", title: "Project rejected" });
      }
      throw error;
    }
  });

  app.get("/api/projects", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    // The list goes through the read layer: one place owns the owner filter.
    return { projects: await listOwnedProjects(user.id) };
  });

  app.get("/api/projects/:projectId", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个项目。" });
    const projectId = projectIdSegment(String((req.params as { projectId?: string }).projectId ?? ""));
    if (!projectId) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个项目。" });
    const access = await requireProjectOwner(user.id, projectId);
    if (access.kind !== "ok") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个项目。" });
    return { project: access.project };
  });

  // The today view of one project (owner only; anyone else, signed in or not, gets the same 404).
  app.get("/api/projects/:projectId/today", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const project = await ownedProject(req);
    if (!project) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个项目。" });
    return buildToday(project, project.ownerId, { record: true });
  });

  // "看完了": the checkpoint moves to the `until` of the payload the reader saw, never backwards.
  app.post("/api/projects/:projectId/today/ack", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const project = await ownedProject(req);
    if (!project) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个项目。" });
    const through = new Date(String(bodyOf(req).through ?? ""));
    try {
      return { checkpoint: await acknowledgeToday(project.ownerId, project.id, through) };
    } catch (error) {
      if (!(error instanceof AckRejected)) throw error;
      return sendProblem(req, reply, { status: 400, code: error.reason.replace("-", "_"), detail: "确认的时间不对，请刷新后再确认。" });
    }
  });

  // The user's own today across all their projects (今日: the fixed issue v3).
  app.get("/api/me/today", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    return buildUserIssue(user.id);
  });

  app.post("/api/me/today/ack", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    try {
      return { checkpoint: await acknowledgeUserToday(user.id, new Date(String(bodyOf(req).through ?? ""))) };
    } catch (error) {
      if (!(error instanceof AckRejected)) throw error;
      return sendProblem(req, reply, { status: 400, code: error.reason.replace("-", "_"), detail: "确认的时间不对，请刷新后再确认。" });
    }
  });

  // 看过了 / 稍后看 (mark: "seen" | "later" | null to clear).
  app.post("/api/me/today/mark", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const b = bodyOf(req);
    const mark = b.mark === "seen" || b.mark === "later" ? b.mark : b.mark === null ? null : undefined;
    if (mark === undefined) return sendProblem(req, reply, { status: 400, code: "bad_mark", detail: "mark 只能是 seen、later 或 null。" });
    const ok = await markItem(user.id, String(b.articleId ?? ""), mark);
    if (!ok) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这条内容。" });
    return { ok: true };
  });

  // The web reminder: a private Atom feed of the reader's own issue. GET reads whether it is on; POST
  // turns it on or rotates it (the URL is shown only in this answer); DELETE turns it off.
  app.get("/api/me/issue-feed", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    return issueFeedState(user.id);
  });
  app.post("/api/me/issue-feed", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const token = await rotateIssueFeed(user.id);
    return { ...(await issueFeedState(user.id)), url: siteUrl(issueFeedPath(token)) };
  });
  app.delete("/api/me/issue-feed", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    await disableIssueFeed(user.id);
    return { enabled: false, createdAt: null, lastReadAt: null };
  });
  // The feed itself: the token is the only credential; an unknown or retired one is a plain 404.
  app.get("/feed/issue/:file", async (req, reply) => {
    const file = String((req.params as { file?: string }).file ?? "");
    const token = file.endsWith(".xml") ? file.slice(0, -4) : "";
    reply.header("X-Robots-Tag", "noindex, nofollow").header("Referrer-Policy", "no-referrer");
    const userId = token ? await userForIssueFeed(token) : null;
    if (!userId) return reply.code(404).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Not found");
    try {
      const xml = await issueFeedXml(userId, token);
      return sendTextWithEtag(req, reply, xml, { etagPrefix: "issue-feed", cacheControl: "private, max-age=300", contentType: "application/atom+xml; charset=utf-8" });
    } catch (error) {
      req.log.error({ err: error }, "issue feed error");
      return reply.code(503).header("Retry-After", "60").header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Feed temporarily unavailable");
    }
  });

  // 往期: the archive of the user's fixed issues, newest first, and the header's 期数.
  app.get("/api/me/issues", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    return { archive: await listPastIssues(user.id, { limit: 365 }), issueCount: await issueCount(user.id) };
  });

  // One past issue, all fields (the 问题 view).
  app.get("/api/me/issues/:date", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const date = String((req.params as { date?: string }).date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendProblem(req, reply, { status: 400, code: "bad_date", detail: "日期要像 2026-10-23 这样。" });
    // Well-formed but not a day (2026-02-30): no such issue, instead of a database error.
    if (!isIssueDate(date)) return reply.code(404).send({ error: "not-found" });
    const issue = await readIssue(user.id, date);
    if (!issue) return reply.code(404).send({ error: "not-found" });
    return { issue };
  });

  // OPENED (the read state of one issue item).
  app.post("/api/me/issues/read", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const articleId = String(bodyOf(req).articleId ?? "");
    if (!articleId) return sendProblem(req, reply, { status: 400, code: "article_required", detail: "缺 articleId。" });
    if (!(await recordOpened(user.id, articleId))) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这条内容。" });
    return { ok: true };
  });

  app.get("/api/pack-prefs", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const prefs = await loadPackPrefs(user.id);
    return { packId: prefs?.packId ?? null, picks: prefs?.picks ?? [] };
  });

  app.put("/api/pack-prefs", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const packId = String(bodyOf(req).packId ?? "").trim();
    if (!packId) return sendProblem(req, reply, { status: 400, code: "pack_required", detail: "请选择一个策展包。" });
    const packs = await listSourcePacks();
    const pack = packs.find((candidate) => candidate.id === packId);
    if (!pack) {
      return sendProblem(req, reply, { status: 400, code: "unknown_pack", detail: "没有这个策展包，请重新选择。" });
    }
    if (!pack.available) {
      return sendProblem(req, reply, { status: 400, code: "pack_unavailable", detail: `「${pack.label}」包还没接上可采集的信源，换一个包或先让管理员导入信源。` });
    }
    const rawPicks = bodyOf(req).picks;
    const picks = Array.isArray(rawPicks) ? rawPicks.filter((p): p is string => typeof p === "string") : [];
    const saved = await savePackPrefs(user.id, { packId, picks });
    return { packId: saved.packId, picks: saved.picks };
  });
}
