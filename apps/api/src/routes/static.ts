// Static files: robots, security.txt, the web manifest, icons and the about page's contact codes.
import { open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SITE } from "@topka/industry/site";
import { REPO_ROOT, config } from "@topka/backend/config";
import { sendTextWithEtag } from "../http/respond.ts";
import { LIMITS } from "../http/rate-limit.ts";

const BRAND = path.join(REPO_ROOT, "industry/brand");

const TYPES: Record<string, string> = {
  ".json": "application/json; charset=UTF-8",
  ".txt": "text/plain; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const fileCache = new Map<string, { body: Buffer; etag: string; mtime: number }>();

/**
 * `name` inside `dir`, or null when it would land anywhere else. The routes already allow only plain
 * file names; this is the check that holds even if a pattern is loosened later.
 */
export function within(dir: string, name: string): string | null {
  const root = path.resolve(dir);
  const file = path.resolve(root, name);
  return file.startsWith(root + path.sep) ? file : null;
}

/** One open handle for the size check and the read, so the cache never pairs one file's mtime with another's bytes. */
async function loadFile(file: string) {
  const handle = await open(file, "r");
  try {
    const s = await handle.stat();
    const cached = fileCache.get(file);
    if (cached && cached.mtime === s.mtimeMs) return cached;
    const body = await handle.readFile();
    const entry = { body, etag: `W/"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`, mtime: s.mtimeMs };
    fileCache.set(file, entry);
    return entry;
  } finally {
    await handle.close();
  }
}

/** The first of `files` that opens (a null is a name refused by within()), else 404. */
async function sendFile(req: FastifyRequest, reply: FastifyReply, files: string | null | (string | null)[], opts: { type?: string; cacheControl: string }) {
  let entry;
  let file = "";
  for (const candidate of Array.isArray(files) ? files : [files]) {
    if (!candidate) continue;
    entry = await loadFile(candidate).catch(() => undefined);
    if (entry) {
      file = candidate;
      break;
    }
  }
  if (!entry) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  reply.header("Content-Type", opts.type ?? TYPES[path.extname(file)] ?? "application/octet-stream");
  reply.header("Cache-Control", opts.cacheControl);
  reply.header("ETag", entry.etag);
  if (req.headers["if-none-match"] === entry.etag) return reply.code(304).send();
  return reply.send(entry.body);
}

function robotsTxt(): string {
  return [
    "User-agent: *",
    "Disallow: /api/",
    "Disallow: /admin/",
    "Disallow: /feedback",
    "",
  ].join("\n");
}

function manifest() {
  return {
    name: `${SITE.name} — ${SITE.tagline}`,
    short_name: SITE.name,
    description: SITE.description,
    lang: SITE.locale,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f2ec",
    theme_color: "#f4f2ec",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

export function registerStatic(app: FastifyInstance) {
  app.get("/robots.txt", (req, reply) => sendTextWithEtag(req, reply, robotsTxt(), { etagPrefix: "robots", cacheControl: "public, max-age=3600", contentType: "text/plain; charset=utf-8" }));

  app.get("/.well-known/security.txt", (req, reply) => {
    if (!SITE.contactEmail) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    const expires = new Date(Date.now() + 180 * 86400_000).toISOString();
    const text = `Contact: mailto:${SITE.contactEmail}\nExpires: ${expires}\nPreferred-Languages: zh, en\nCanonical: ${config.siteUrl}/.well-known/security.txt\n`;
    return sendTextWithEtag(req, reply, text, { etagPrefix: "security", cacheControl: "public, max-age=86400", contentType: "text/plain; charset=utf-8" });
  });

  app.get("/manifest.webmanifest", (req, reply) =>
    sendTextWithEtag(req, reply, JSON.stringify(manifest()), { etagPrefix: "manifest", cacheControl: "public, max-age=86400", contentType: "application/manifest+json" }));

  // Icons from the industry pack (industry/brand/).
  for (const icon of ["favicon.ico", "icon.png", "icon-192.png", "apple-icon.png", "logo.svg"]) {
    app.get(`/${icon}`, (req, reply) => sendFile(req, reply, path.join(BRAND, icon), { cacheControl: "public, max-age=86400, stale-while-revalidate=604800" }));
  }

  // Contact codes on the about page: uploaded in the admin (content-hashed names), or shipped in the pack.
  app.get("/contact/:file", { config: { rateLimit: LIMITS.file } }, async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[\w.-]+\.(png|jpg|jpeg|webp)$/.test(file)) return reply.code(404).send();
    const hashed = /-[0-9a-f]{8}\./.test(file);
    const cacheControl = hashed ? "public, max-age=31536000, immutable" : "public, max-age=3600";
    return sendFile(req, reply, [within(path.join(config.dataDir, "uploads"), file), within(path.join(BRAND, "contact"), file)], { cacheControl });
  });
}
