// Share images (1200×630 PNG) for the site and its static pages; anything else is a real 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SITE } from "@topka/industry/site";
import { ogEtag, renderOg, type OgCard } from "../og/render.ts";

const PAGES: Record<string, OgCard> = {
  site: { kicker: SITE.name, title: SITE.tagline, subtitle: SITE.description },
  about: { kicker: "关于", title: `关于 ${SITE.name}`, subtitle: SITE.description },
  terms: { kicker: "使用规则", title: `${SITE.name} 使用规则`, subtitle: "账号、项目、每日一期与订阅地址的使用范围。" },
  privacy: { kicker: "隐私说明", title: `${SITE.name} 隐私说明`, subtitle: "账号、项目、访问日志与反馈资料的处理方式。" },
  feedback: { kicker: "反馈", title: "告诉我们哪里可以更好", subtitle: "内容、功能，或来源方的更正与下架请求。" },
};

async function send(req: FastifyRequest, reply: FastifyReply, card: OgCard, maxAge: number) {
  const tag = `"og-${ogEtag(card)}"`;
  reply.header("ETag", tag).header("Cache-Control", `public, max-age=${maxAge}, s-maxage=${maxAge * 7}, stale-while-revalidate=86400`);
  if (String(req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
  return reply.type("image/png").send((await renderOg(card)).png);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).header("Cache-Control", "public, max-age=300").type("text/plain; charset=utf-8").send("Not found");
}

export function registerOg(app: FastifyInstance) {
  app.get("/og/site.png", (req, reply) => send(req, reply, PAGES.site!, 86400));

  app.get("/og/pages/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const card = file.endsWith(".png") ? PAGES[file.slice(0, -4)] : undefined;
    return card ? send(req, reply, card, 86400) : notFound(reply);
  });
}
