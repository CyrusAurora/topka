// Discovery channels and pending-evidence signals (master design 1.2, 3.2 discovery_signals, 8.2
// step 10; handover 2.9/3.7, CAP-05): one pure module shared by the backend (which stores signals and
// runs the promotion gate) and the pages (which show the capped pending list). Nothing here fetches,
// probes reachability or infers evidence: the gate only looks at the URLs of observations the caller
// already saved. Every rule is covered by the tables in tests/discovery-signals.test.ts.
//
// A DiscoverySignal is a candidate from a channel (a directory feed, a project's pack, or a lead the
// reader gave), never a source, an observation, an event or an update. It never enters a brief or an
// issue, cannot support "no important change", cannot block a confirmation and never turns into an
// event by itself. It is promoted only when a saved observation has the same URL identity; from then
// on the observation (already in the ledger) is what issues read, and the signal is lineage.

export const CHANNEL_KINDS = ["directory", "pack", "user-lead"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const SIGNAL_STATUSES = ["awaiting", "promoted", "dismissed"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/** The pending list's cap (master design appendix: "20 条"); also its ceiling. */
export const DEFAULT_PENDING_CAP = 20;

// --- URL identity ---------------------------------------------------------------------------------
//
// The nine rules of the v0 identity (handover 3.7), then the four decisions this build adds (recorded
// in master design 3.2 "发现信号的 URL 身份"):
//   1. only an absolute URL;                       2. only http: and https:;
//   3. a URL with userinfo (user:pass@) is refused; 4. identity = origin + pathname;
//   5. the query is ignored;                       6. the fragment is ignored;
//   7. the path is case-sensitive;                 8. a non-root path drops its trailing slash(es);
//   9. http and https are different identities.
// Decisions on top of v0:
//   A. the origin is the WHATWG origin: host lower-cased (IDN to punycode), a trailing dot dropped,
//      the scheme's default port dropped; any other port stays part of the identity. No generic
//      "www." folding (www.example.com is another origin), unlike the observation key in lib/url.ts.
//   B. identity-bearing queries: on the few pages whose query IS the address (a WeChat article, a
//      Hacker News item, a YouTube video) the named parameters stay, sorted; every other parameter,
//      tracking parameters included (utm_*, fbclid, spm …), is dropped by rule 5 everywhere.
//   C. redirect wrappers that carry their target in the query (google.com/url?q=, l.facebook.com,
//      link.zhihu.com, out.reddit.com …) are unwrapped, at most three levels, before the identity is
//      taken; a wrapper whose target is not itself a valid URL is invalid. Redirects only visible by
//      fetching (t.co, feedproxy) are not followed: the gate never fetches. The observation side
//      covers the rest: every URL the observation recorded (its address and its feed guid) counts.
//   D. mirrors: a closed table of hosts known to serve the same page maps to one canonical host
//      (twitter.com → x.com, old.reddit.com → www.reddit.com, export.arxiv.org → arxiv.org, …), plus
//      two path mirrors (youtu.be/ID → www.youtube.com/watch?v=ID, arxiv /pdf/ID[.pdf] → /abs/ID).
//      The scheme is kept: a mirror never makes http and https equal.
//   E. pages whose query is the only address (found on production data, where rule 5 alone merged
//      unrelated pages into one identity and promoted them to the wrong observation):
//      - search and click-tracking pages (Sogou WeChat search and its /link, Google/Bing/Baidu/
//        DuckDuckGo search) are not addresses of a page at all: no identity, never promoted;
//      - a dynamic script (.asp/.aspx/.php/.jsp/.cgi/.do/.cfm) or the site root with a query keeps its
//        query minus tracking parameters (sorted): /more.asp?id=1 and ?id=2, /?p=12 and ?p=13 differ.

/** Hosts whose pages are identified by part of the query: path prefix and the parameters kept. */
const IDENTITY_QUERY: ReadonlyArray<{ host: string; path: RegExp; keep: readonly string[] }> = [
  { host: "mp.weixin.qq.com", path: /^\/s$/, keep: ["__biz", "mid", "idx", "sn"] },
  { host: "news.ycombinator.com", path: /^\/item$/, keep: ["id"] },
  { host: "www.youtube.com", path: /^\/watch$/, keep: ["v"] },
];

/** Redirect wrappers: host, path and the parameter that carries the target. */
const REDIRECT_WRAPPERS: ReadonlyArray<{ host: string; path: RegExp; param: readonly string[] }> = [
  { host: "www.google.com", path: /^\/url$/, param: ["q", "url"] },
  { host: "google.com", path: /^\/url$/, param: ["q", "url"] },
  { host: "l.facebook.com", path: /^\/l\.php$/, param: ["u"] },
  { host: "lm.facebook.com", path: /^\/l\.php$/, param: ["u"] },
  { host: "link.zhihu.com", path: /^\/?$/, param: ["target"] },
  { host: "out.reddit.com", path: /^\/[^/]+$/, param: ["url"] },
  { host: "www.douban.com", path: /^\/link2\/?$/, param: ["url"] },
  { host: "link.juejin.cn", path: /^\/?$/, param: ["target"] },
  { host: "weibo.cn", path: /^\/sinaurl$/, param: ["u", "toasturl"] },
];

/** Mirror hosts and their canonical host (decision D). */
export const MIRROR_HOSTS: Readonly<Record<string, string>> = {
  "twitter.com": "x.com",
  "www.twitter.com": "x.com",
  "mobile.twitter.com": "x.com",
  "www.x.com": "x.com",
  "mobile.x.com": "x.com",
  "reddit.com": "www.reddit.com",
  "old.reddit.com": "www.reddit.com",
  "new.reddit.com": "www.reddit.com",
  "np.reddit.com": "www.reddit.com",
  "m.reddit.com": "www.reddit.com",
  "export.arxiv.org": "arxiv.org",
  "www.arxiv.org": "arxiv.org",
  "youtube.com": "www.youtube.com",
  "m.youtube.com": "www.youtube.com",
  "music.youtube.com": "www.youtube.com",
};

/** Search and click-tracking pages: not the address of a page (decision E). */
const SEARCH_PAGES: ReadonlyArray<{ host: string; path: RegExp }> = [
  { host: "weixin.sogou.com", path: /^\/(weixin|link)$/ },
  { host: "www.sogou.com", path: /^\/(web|link|sogou)$/ },
  { host: "www.google.com", path: /^\/search$/ },
  { host: "google.com", path: /^\/search$/ },
  { host: "www.bing.com", path: /^\/search$/ },
  { host: "cn.bing.com", path: /^\/search$/ },
  { host: "www.baidu.com", path: /^\/(s|link)$/ },
  { host: "duckduckgo.com", path: /^\/(html\/?)?$/ },
];
/** Tracking parameters: never part of an identity, even where the query otherwise is (decision E). */
const TRACKING = /^(utm_[a-z_]+|spm|from|ref|ref_src|ref_url|source|share_source|share_token|fbclid|gclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|scene|chksm|sessionid|srcid|clicktime|enterid|mkt_tok|s|si|feature)$/i;
const DYNAMIC_SCRIPT = /\.(asp|aspx|php|jsp|cgi|do|cfm)$/i;

export type UrlIdentityRefusal = "not-absolute" | "not-http" | "userinfo" | "bad-wrapper" | "search-page";
export type UrlIdentityResult = { ok: true; identity: string } | { ok: false; reason: UrlIdentityRefusal };

const MAX_UNWRAP = 3;

function parseAbsolute(input: string): URL | null {
  const s = input.trim();
  // An absolute URL names its scheme; "//host/path" and "/path" are relative (rule 1).
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** The URL identity of a candidate or an observation address, or why it has none. */
export function urlIdentity(input: unknown): UrlIdentityResult {
  if (typeof input !== "string" || !input.trim()) return { ok: false, reason: "not-absolute" };
  let u = parseAbsolute(input);
  for (let depth = 0; ; depth++) {
    if (!u) return { ok: false, reason: depth ? "bad-wrapper" : "not-absolute" };
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: depth ? "bad-wrapper" : "not-http" };
    if (u.username || u.password) return { ok: false, reason: "userinfo" };
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    const wrapper = depth < MAX_UNWRAP ? REDIRECT_WRAPPERS.find((w) => w.host === host && w.path.test(u!.pathname)) : undefined;
    if (!wrapper) break;
    const target = wrapper.param.map((p) => u!.searchParams.get(p)).find((v) => v && v.trim());
    if (!target) return { ok: false, reason: "bad-wrapper" };
    u = parseAbsolute(target);
  }
  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  let path = u.pathname;
  let query = "";
  // Path mirrors first (decision D), then host mirrors.
  if (host === "youtu.be" && /^\/[A-Za-z0-9_-]+$/.test(path)) {
    query = `v=${path.slice(1)}`;
    host = "www.youtube.com";
    path = "/watch";
  }
  host = MIRROR_HOSTS[host] ?? host;
  if (host === "arxiv.org") {
    const pdf = /^\/pdf\/(.+?)(?:\.pdf)?\/?$/.exec(path);
    if (pdf) path = `/abs/${pdf[1]}`;
  }
  // Rule 8: drop trailing slashes of a non-root path; the root stays "/".
  if (path !== "/") path = path.replace(/\/+$/, "") || "/";
  // Upper-case hex in percent escapes: %e4 and %E4 are the same octet (WHATWG keeps what it got).
  path = path.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
  if (SEARCH_PAGES.some((p) => p.host === host && p.path.test(path))) return { ok: false, reason: "search-page" };
  const rule = IDENTITY_QUERY.find((r) => r.host === host && r.path.test(path));
  if (!rule && !query && (path === "/" || DYNAMIC_SCRIPT.test(path))) {
    const params = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (!TRACKING.test(k) && v !== "") params.append(k, v);
    params.sort();
    query = params.toString();
  }
  if (rule && !query) {
    const params = new URLSearchParams();
    for (const k of rule.keep) {
      const v = u.searchParams.get(k);
      if (v) params.set(k, v);
    }
    params.sort();
    query = params.toString();
  }
  const defaultPort = (u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443") || !u.port;
  const origin = `${u.protocol}//${host}${defaultPort ? "" : `:${u.port}`}`;
  return { ok: true, identity: `${origin}${path}${query ? `?${query}` : ""}` };
}

/** The identity string, or null for a URL that can never be promoted. */
export function identityOf(input: unknown): string | null {
  const r = urlIdentity(input);
  return r.ok ? r.identity : null;
}

// --- the gate -------------------------------------------------------------------------------------

export interface SignalCandidate {
  id: string;
  url: string;
  /** When the channel first showed it (ISO); an unparsable value sorts after every valid one. */
  discoveredAtUtc: string | null;
}

export interface SavedObservation {
  id: string;
  /** Every address the observation recorded: its URL and, when it is one, its feed guid. */
  urls: readonly string[];
  capturedAtUtc: string | null;
}

export interface Promotion {
  signalId: string;
  observationId: string;
  identity: string;
}

export interface GateResult {
  promoted: Promotion[];
  /** Still pending: no saved observation shares the identity. */
  awaiting: string[];
  /** No identity at all: visible in the pending list, never promoted. */
  invalid: string[];
}

function timeOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Earliest valid time first, invalid times after every valid one, then the smallest id. */
export function compareEarliest(a: { id: string; at: string | null }, b: { id: string; at: string | null }): number {
  const ta = timeOf(a.at);
  const tb = timeOf(b.at);
  if (ta !== null && tb !== null && ta !== tb) return ta - tb;
  if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The promotion gate (pure): a candidate is promoted only when a saved observation has the same URL
 * identity, and carries that observation's id. With several matching observations the earliest
 * captured wins (ties: smallest id), so the answer does not depend on input order. Every candidate
 * sharing the identity is promoted to the same observation (duplicates fold at display, not here).
 */
export function promotionGate(signals: readonly SignalCandidate[], observations: readonly SavedObservation[]): GateResult {
  const byIdentity = new Map<string, { id: string; at: string | null }>();
  for (const o of observations) {
    const seen = new Set<string>();
    for (const url of o.urls) {
      const identity = identityOf(url);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      const current = byIdentity.get(identity);
      const mine = { id: o.id, at: o.capturedAtUtc };
      if (!current || compareEarliest(mine, current) < 0) byIdentity.set(identity, mine);
    }
  }
  const out: GateResult = { promoted: [], awaiting: [], invalid: [] };
  for (const s of [...signals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const identity = identityOf(s.url);
    if (!identity) {
      out.invalid.push(s.id);
      continue;
    }
    const hit = byIdentity.get(identity);
    if (hit) out.promoted.push({ signalId: s.id, observationId: hit.id, identity });
    else out.awaiting.push(s.id);
  }
  return out;
}

// --- the pending list -----------------------------------------------------------------------------

/** The cap as asked, or the default: anything but an integer in 1..20 fails closed to 20. */
export function normalizeCap(raw: unknown): number {
  const n = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= DEFAULT_PENDING_CAP ? n : DEFAULT_PENDING_CAP;
}

export interface PendingInput extends SignalCandidate {
  status?: SignalStatus;
}

export interface PendingList<T> {
  /** Representatives, newest discovery first, at most `cap`. */
  items: Array<T & { identity: string | null; duplicates: number }>;
  /** Representatives before the cap. */
  total: number;
  /** Representatives cut by the cap. */
  hidden: number;
  /** The cap applied (after normalizeCap). */
  cap: number;
}

/**
 * The pending list: awaiting signals only; duplicates (same identity) fold into one representative —
 * the earliest discovered, ties to the smallest id, invalid times after valid ones; a signal without
 * an identity is its own entry. Ordered newest discovery first (a list ordered oldest first would
 * freeze on its first 20 leads), ties to the smallest id, invalid times last; then cut to the cap.
 */
export function pendingList<T extends PendingInput>(signals: readonly T[], cap?: unknown): PendingList<T> {
  const limit = normalizeCap(cap);
  const groups = new Map<string, T[]>();
  const singles: T[] = [];
  for (const s of signals) {
    if (s.status && s.status !== "awaiting") continue;
    const identity = identityOf(s.url);
    if (!identity) singles.push(s);
    else groups.set(identity, [...(groups.get(identity) ?? []), s]);
  }
  const reps: Array<T & { identity: string | null; duplicates: number }> = [];
  for (const [identity, members] of groups) {
    const rep = [...members].sort((a, b) => compareEarliest({ id: a.id, at: a.discoveredAtUtc }, { id: b.id, at: b.discoveredAtUtc }))[0]!;
    reps.push({ ...rep, identity, duplicates: members.length - 1 });
  }
  for (const s of singles) reps.push({ ...s, identity: null, duplicates: 0 });
  reps.sort((a, b) => {
    const ta = timeOf(a.discoveredAtUtc);
    const tb = timeOf(b.discoveredAtUtc);
    if (ta !== null && tb !== null && ta !== tb) return tb - ta;
    if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { items: reps.slice(0, limit), total: reps.length, hidden: Math.max(0, reps.length - limit), cap: limit };
}
