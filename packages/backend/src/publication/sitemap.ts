// Sitemap of the few public pages (the old Topka report, topic, story, leaderboard and item pages are
// retired and redirect, so they are not listed). Cached ~5 minutes and rebuilt in the background after that (crawlers get the previous copy meanwhile); if the database fails, the last
// successful sitemap is served (never an empty one). Bounded.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { escapeXml } from "../lib/text.ts";
import { SITE } from "@topka/industry/site";
import { siteUrl } from "./links.ts";

const MAX_URLS = 45_000;
const TTL_MS = 5 * 60 * 1000;
const CACHE_FILE = path.join(config.dataDir, "sitemap-last.xml");

let lastGood: string | null = null;

interface Entry {
  loc: string;
  lastmod?: Date | null;
  changefreq?: string;
  priority?: number;
}

/** The public pages a crawler may index. The home page is the reader's own 今日 (its signed-out view
 * is the product's front door); everything else is personal or a redirect, so it is not listed. */
export const SITEMAP_PATHS: readonly string[] = SITE.legalPages ? ["/", "/about", "/terms", "/privacy"] : ["/", "/about"];

async function build(): Promise<string> {
  const [latestItem] = await sql<{ t: Date | null }[]>`SELECT max(timeline_at) AS t FROM publications WHERE visibility = 'public' AND in_scope AND selected`;
  const now = latestItem?.t ?? new Date();
  const entries: Entry[] = [
    { loc: "/", lastmod: now, changefreq: "daily", priority: 1 },
    { loc: "/about", changefreq: "monthly", priority: 0.5 },
    ...(SITE.legalPages ? [{ loc: "/terms", changefreq: "monthly", priority: 0.4 }, { loc: "/privacy", changefreq: "monthly", priority: 0.4 }] : []),
  ];
  const body = entries
    .slice(0, MAX_URLS)
    .map((e) => {
      const parts = [`<loc>${escapeXml(siteUrl(e.loc))}</loc>`];
      if (e.lastmod) parts.push(`<lastmod>${e.lastmod.toISOString()}</lastmod>`);
      if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
      if (e.priority !== undefined) parts.push(`<priority>${e.priority}</priority>`);
      return `<url>\n${parts.join("\n")}\n</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

const sitemap = cached(refreshSitemap, { freshMs: TTL_MS, maxStaleMs: 60 * 60_000 });

export function sitemapXml(): Promise<string> {
  return sitemap.get();
}

async function refreshSitemap(): Promise<string> {
  try {
    const xml = await build();
    lastGood = xml;
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, xml).catch(() => {});
    return xml;
  } catch (error) {
    if (lastGood) return lastGood;
    const last = await readFile(CACHE_FILE, "utf8").catch(() => null);
    if (last) return last;
    throw error;
  }
}
