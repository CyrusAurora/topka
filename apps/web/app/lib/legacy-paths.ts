// The retired Topka public pages (timeline, hot list, reports, topics, leaderboard, …). Topka's web
// is the personal magazine; each old path answers 301 to 今日 (/) or 往期 (/archive) so bookmarks,
// search results and old RSS readers land somewhere real. Pure data so routes.ts and tests share it.

/** Route patterns (React Router syntax, no leading slash). */
export const LEGACY_PATHS = [
  "all", "all/search-busy", "search-busy",
  "hot", "story/:publicId",
  "daily", "daily/archive", "daily/:key", "weekly", "weekly/:key", "monthly", "monthly/:key",
  "topics", "topics/:slug", "topics/:slug/page/:page",
  "changelog", "more", "starred", "agent",
  "codex-reset", "codex-reset/history/:date",
  "leaderboard", "leaderboard/category/:key", "leaderboard/sources", "leaderboard/sources/:key", "leaderboard/rules", "leaderboard/:slug",
] as const;

/** Where an old path goes: report pages to 往期, everything else to 今日. */
export function legacyTarget(pathname: string): string {
  return /^\/(daily|weekly|monthly)(\/|$)/.test(pathname) ? "/archive" : "/";
}
