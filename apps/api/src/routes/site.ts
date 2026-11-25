// First-party site API (/api/site/*): what the web app's public pages read (about, contact, feedback)
// and the target of old item links. Not public, not versioned; no cookies are read or set.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadContact, loadMakerAvatar } from "@topka/backend/site/contact";
import { loadSiteStats } from "@topka/backend/site/stats";
import { itemOriginal } from "@topka/backend/site/items";
import { registerFeedback } from "./feedback.ts";
import { sendJsonWithEtag, sendProblem } from "../http/respond.ts";

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function siteHandler(fn: Handler): Handler {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (error) {
      req.log.error({ err: error, path: req.url.split("?")[0] }, "site api error");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "temporarily unavailable", retryAfter: 10 });
    }
  };
}

export function registerSite(app: FastifyInstance) {
  app.get("/api/site/items/:id", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const item = /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? await itemOriginal(id) : null;
    if (!item) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, item, { etagPrefix: "item", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/contact", siteHandler(async (req, reply) => {
    const [contact, makerAvatar] = await Promise.all([loadContact(), loadMakerAvatar()]);
    return sendJsonWithEtag(req, reply, { ...contact, makerAvatar }, { etagPrefix: "contact", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  app.get("/api/site/stats", siteHandler(async (req, reply) => {
    return sendJsonWithEtag(req, reply, await loadSiteStats(), { etagPrefix: "stats", cacheControl: "public, max-age=300, s-maxage=300" });
  }));

  registerFeedback(app);
}
