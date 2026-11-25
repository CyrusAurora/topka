// Outward HTTP behaviour, defined once: redirects, retired paths and which process owns a path.
// The API server and the web server both read this module.

export const NO_STORE = "no-store";

export interface RedirectRule {
  match: "exact" | "regex" | "prefix";
  path: string;
  status: 301 | 302 | 307 | 308 | 404 | 410;
  /** Relative Location. `$1`… refer to regex groups; `*` appends the remainder for prefix rules. */
  location?: string;
  keepQuery?: boolean;
  headers?: Record<string, string>;
  why?: string;
}

/** Redirects. Locations are always relative, so they stay right behind any proxy. */
export const REDIRECTS: RedirectRule[] = [
  {
    match: "regex",
    path: "^/(about|feedback|privacy|terms|today|archive|chat|settings)/+$",
    status: 301,
    location: "/$1",
    keepQuery: true,
  },
  {
    match: "regex",
    path: "^/(feed(\\.xml|/(?!issue/).*)?|rss|rss\\.xml|atom\\.xml|openapi-v1\\.json|llms\\.txt|sitemap\\.xml|sitemaps/.*|items/[^/]+/markdown)$",
    status: 410,
    why: "the public timeline feeds, sitemap and machine exits are retired; a reader's own feed lives under /feed/issue/",
  },
  { match: "regex", path: "^/api/(v1|mcp)(/.*)?$", status: 410, why: "the public API and MCP are retired" },
  { match: "prefix", path: "/sources", status: 302, location: "/admin/sources*", why: "admin bookmarks" },
];

export interface RedirectDecision {
  status: number;
  location: string | null;
  headers: Record<string, string>;
}

export function resolveRedirect(pathname: string, search: string): RedirectDecision | null {
  for (const rule of REDIRECTS) {
    let location: string | null = null;
    if (rule.match === "exact") {
      if (pathname !== rule.path) continue;
      location = rule.location ?? null;
    } else if (rule.match === "prefix") {
      const inTree = rule.path.endsWith("/")
        ? pathname.startsWith(rule.path)
        : pathname === rule.path || pathname.startsWith(`${rule.path}/`);
      if (!inTree) continue;
      location = rule.location ? rule.location.replaceAll("*", pathname.slice(rule.path.length)) : null;
    } else {
      const m = new RegExp(rule.path).exec(pathname);
      if (!m) continue;
      location = rule.location ? rule.location.replace(/\$(\d)/g, (_s, i: string) => m[Number(i)] ?? "") : null;
    }
    if (location && rule.keepQuery && search) location += search;
    return { status: rule.status, location, headers: rule.headers ?? {} };
  }
  return null;
}

/**
 * Paths served by the api process; everything else is the web process. The web server proxies these to
 * the api (a reverse proxy in front may also route them straight to it). Patterns are anchored so page
 * paths such as /feedback never fall into /feed.
 */
export const API_OWNED_PATTERNS: RegExp[] = [
  /^\/api\//,
  /^\/feed(\.xml|\/.*)?$/,
  /^\/(rss|rss\.xml|atom\.xml|openapi-v1\.json|llms\.txt|sitemap\.xml)$/,
  /^\/(robots\.txt|manifest\.webmanifest)$/,
  /^\/sitemaps\//,
  /^\/\.well-known\//,
  /^\/(favicon\.ico|icon\.png|icon-192\.png|apple-icon\.png|logo\.svg)$/,
  /^\/(og|contact)\//,
  /^\/items\/[^/]+\/markdown$/,
];

export function isApiOwned(pathname: string): boolean {
  return API_OWNED_PATTERNS.some((re) => re.test(pathname));
}
