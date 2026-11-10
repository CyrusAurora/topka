// Source independence: which reports of a story are really one upstream told again. A report is a
// copy of another when its text nearly repeats it (a syndicated or mirrored article), when it is a link
// post of an aggregator (its URL is someone else's article), when a short brief ends with the link it
// summarises, or when its lead says it relays a named outlet ("据路透社报道", "according to Reuters").
// Each report gets an upstream key; reports sharing a key are one upstream, and the story's count of
// independent upstreams is the number of distinct keys. Company statements ("according to Google")
// are not an outlet: a report written from them is still its own report.
// Deterministic and model-free: docs/quality.md (source independence) measures it on a labelled set.

export interface UpstreamItem {
  id: string;
  sourceId: string;
  sourceName: string;
  /** The source posts links to other sites (Hacker News and the like): its URL names the upstream. */
  aggregator: boolean;
  url: string;
  title: string;
  publishedAt: Date | string | null;
  /** The text the report opens with (body or excerpt), at least ~400 characters when there is any. */
  lead: string;
  /** The last ~400 characters of the body: where a brief puts the link it summarises. */
  tail: string;
  /** Length of the body in characters (0 without one). */
  bodyChars: number;
  /** MinHash signature of the body (fingerprint()); empty when there is no body. */
  signature: number[];
  /** The source's signal group (sources.signal_group_id): sources an operator declared one voice. */
  signalGroupId?: string | null;
}

/** A report's own key: its signal group's when it has one, else its source's (events/group.ts participantKey). */
export const ownKey = (it: Pick<UpstreamItem, "sourceId" | "signalGroupId">) => (it.signalGroupId ? `group:${it.signalGroupId}` : `source:${it.sourceId}`);

/** Outlets a report may say it relays, by the names they appear under, mapped to one key each. */
const OUTLETS: Array<[RegExp, string]> = [
  [/路透|reuters/i, "reuters.com"],
  [/彭博|bloomberg/i, "bloomberg.com"],
  [/纽约时报|new york times|\bnyt\b|nytimes/i, "nytimes.com"],
  [/华尔街日报|wall street journal|\bwsj\b/i, "wsj.com"],
  [/the information/i, "theinformation.com"],
  [/金融时报|financial times|\bft\b/i, "ft.com"],
  [/\bcnbc\b/i, "cnbc.com"],
  [/the verge/i, "theverge.com"],
  [/techcrunch/i, "techcrunch.com"],
  [/ars technica/i, "arstechnica.com"],
  [/美联社|associated press|\bap\b/i, "apnews.com"],
  [/华盛顿邮报|washington post/i, "washingtonpost.com"],
  [/business insider/i, "businessinsider.com"],
  [/\baxios\b/i, "axios.com"],
  [/semafor/i, "semafor.com"],
  [/日经|nikkei/i, "nikkei.com"],
  [/the decoder/i, "the-decoder.com"],
  [/404 ?media/i, "404media.co"],
  [/\bwired\b/i, "wired.com"],
];

/** Hosts that carry many publishers' posts: their host says nothing about the upstream. */
const SHARED_HOSTS = new Set(["weixin.sogou.com", "mp.weixin.qq.com", "github.com", "x.com", "twitter.com", "medium.com", "substack.com", "youtube.com", "arxiv.org"]);

/** A host without "www."/"m." and the like, lower-case; "" for anything that is not an http(s) URL. */
export function siteOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, "");
  } catch {
    return "";
  }
}

/** The outlet key a name or host stands for: a known outlet's domain, else the site itself. */
function outletKey(nameOrHost: string): string {
  for (const [re, key] of OUTLETS) if (re.test(nameOrHost)) return key;
  return nameOrHost;
}

// Relaying a named outlet in the opening lines. The name sits between the verb and 报道/消息 (Chinese)
// or after "according to"/"reported by"/"first reported by" (English), or names itself before the verb.
const RELAY_ZH = /(?:据|援引|转引自?|综合)\s*[《「“"]?([^，。,；;：:\n《》「」“”"]{2,20}?)[》」”"]?\s*(?:援引[^，。,]{0,12})?(?:报道|消息|报导|披露|获悉)/;
const RELAY_EN = /\b(?:according to|reported by|first reported by|as reported by|citing)\s+(?:a report (?:by|from|in)\s+)?(?:the\s+)?([A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,3})/;
// The outlet named before the verb: "…, Wired reported", "彭博社记者古尔曼爆料".
const RELAY_TRAIL = /([A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,3}|[\u4e00-\u9fff]{2,8})\s*(?:记者[^，。,；;]{0,24})?(?:has reported|first reported|reported|reports|爆料|报道称|报道|披露)/;
const LEAD_WINDOW = 320;
const BACKGROUND = /(此前|早前|之前|先前|此前有|earlier|previously|as)\s*$/i;

/** The outlet a report's opening lines say it relays, or null (company statements are not outlets). */
export function relayedOutlet(lead: string): string | null {
  const head = lead.slice(0, LEAD_WINDOW);
  for (const re of [RELAY_ZH, RELAY_EN, RELAY_TRAIL]) {
    for (const m of head.matchAll(new RegExp(re.source, re.flags + "g"))) {
      // "此前据《纽约时报》报道" / "as previously reported by": background for the news, not its source.
      if (BACKGROUND.test(head.slice(Math.max(0, m.index! - 12), m.index!))) continue;
      const name = m[1]!.trim();
      for (const [pattern, key] of OUTLETS) if (pattern.test(name)) return key;
    }
  }
  return null;
}

/** A short brief that ends with the URL of the article it summarises (another site): that site. */
export function briefOrigin(item: Pick<UpstreamItem, "tail" | "url">, bodyChars: number): string | null {
  if (bodyChars > 1500) return null;
  const urls = [...item.tail.matchAll(/https?:\/\/[^\s<>"'）)】]+/g)].map((m) => siteOf(m[0]));
  const own = siteOf(item.url);
  // The first link is the article the brief is about; later ones are background.
  return urls.find((h) => h && h !== own && !SHARED_HOSTS.has(h)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Near-duplicate text: MinHash over character 4-grams of the normalised body.
// ---------------------------------------------------------------------------------------------

export const SIGNATURE_SIZE = 32;
const SHINGLE = 4;
const MAX_TEXT = 4000;

function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** MinHash signature of a text (letters and digits only, lower-case); [] when it is too short. */
export function fingerprint(text: string | null | undefined): number[] {
  const norm = String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, MAX_TEXT);
  if (norm.length < 80) return [];
  const sig = new Array<number>(SIGNATURE_SIZE).fill(0xffffffff);
  for (let i = 0; i + SHINGLE <= norm.length; i++) {
    const sh = norm.slice(i, i + SHINGLE);
    for (let k = 0; k < SIGNATURE_SIZE; k++) {
      const h = fnv1a(sh, k * 0x9e3779b1);
      if (h < sig[k]!) sig[k] = h;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity of two signatures (0 when either is empty). */
export function similarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/** Two reports whose bodies agree this much are one text published twice. */
export const DUPLICATE_SIMILARITY = 0.5;

/** Host and path without query or fragment: one article under two feeds' links. */
const canonical = (url: string) => {
  const host = siteOf(url);
  if (!host) return "";
  try {
    const u = new URL(url);
    // On a shared host the query names the article (weixin.sogou.com/link?url=…); elsewhere it is tracking.
    return host + u.pathname.replace(/\/+$/, "") + (SHARED_HOSTS.has(host) ? u.search : "");
  } catch {
    return "";
  }
};

const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// ---------------------------------------------------------------------------------------------
// Upstream keys
// ---------------------------------------------------------------------------------------------

const time = (d: Date | string | null) => (d ? new Date(d).getTime() : Number.MAX_SAFE_INTEGER);

/** The source's own publication site: the host of its reports when they share one (not a shared host). */
function sourceSites(items: UpstreamItem[]): Map<string, string> {
  const hosts = new Map<string, Set<string>>();
  for (const it of items) {
    if (it.aggregator) continue;
    const h = siteOf(it.url);
    if (!h || SHARED_HOSTS.has(h)) continue;
    if (!hosts.has(it.sourceId)) hosts.set(it.sourceId, new Set());
    hosts.get(it.sourceId)!.add(h);
  }
  const out = new Map<string, string>();
  for (const [id, set] of hosts) if (set.size === 1) out.set(id, [...set][0]!);
  return out;
}

/**
 * Upstream key per report: reports with the same key are one upstream. Keys are "source:<id>" (or
 * "group:<signal group>") for a report that is its own, or "site:<host>" when it relays or links a site; a site that is also one of
 * the story's own sources resolves to that source, so the original and its copies share a key.
 */
export function upstreamKeys(items: UpstreamItem[]): Map<string, string> {
  const sorted = [...items].sort((a, b) => time(a.publishedAt) - time(b.publishedAt) || a.id.localeCompare(b.id));
  const sites = sourceSites(sorted);
  const siteToSource = new Map<string, string>();
  const keyOfSource = new Map(sorted.map((it) => [it.sourceId, ownKey(it)]));
  for (const [id, host] of sites) siteToSource.set(outletKey(host), keyOfSource.get(id)!);
  for (const it of sorted) {
    // A source's own name may be the outlet a report relays ("据 The Verge 报道").
    const named = outletKey(it.sourceName.replace(/\s*[·|｜-].*$/, "").trim());
    if (named !== it.sourceName && !siteToSource.has(named)) siteToSource.set(named, ownKey(it));
  }
  const resolveSite = (host: string) => siteToSource.get(outletKey(host)) ?? `site:${outletKey(host)}`;

  // Union-find over reports: a copy joins the key of what it copies.
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const own = new Map<string, string>();
  for (const it of sorted) {
    let key = ownKey(it);
    if (it.aggregator) {
      const host = siteOf(it.url);
      if (host && !SHARED_HOSTS.has(host)) key = resolveSite(host);
      else key = `link:${it.url}`;
    } else {
      const relayed = relayedOutlet(it.lead) ?? briefOrigin(it, it.bodyChars);
      if (relayed) key = resolveSite(relayed);
    }
    own.set(it.id, key);
    if (!parent.has(key)) parent.set(key, key);
  }
  // Near-identical text or the same title from two sources: the later one is a copy of the earlier.
  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = sorted[j]!, b = sorted[i]!;
      if (a.sourceId === b.sourceId && a.url !== b.url) continue;
      const sameUrl = canonical(a.url) !== "" && canonical(a.url) === canonical(b.url);
      const sameTitle = normTitle(a.title).length >= 12 && normTitle(a.title) === normTitle(b.title);
      if (sameUrl || sameTitle || similarity(a.signature, b.signature) >= DUPLICATE_SIMILARITY) union(own.get(a.id)!, own.get(b.id)!);
    }
  }
  return new Map(sorted.map((it) => [it.id, find(own.get(it.id)!)]));
}

/**
 * The participant a new report counts as, given the participants already counted in its story
 * (article id → participant key): the participant of a report it copies, else its own key.
 */
export function assignParticipant(items: UpstreamItem[], newId: string, existing: Map<string, string>, own: string): string {
  const keys = upstreamKeys(items);
  const mine = keys.get(newId);
  const peer = items.find((i) => i.id !== newId && existing.has(i.id) && keys.get(i.id) === mine);
  return peer ? existing.get(peer.id)! : own;
}

/** Number of independent upstreams among a story's reports. */
export function independentUpstreams(items: UpstreamItem[]): number {
  return new Set(upstreamKeys(items).values()).size;
}

/**
 * Whether a source posts links to other publishers: across its recent reports the URLs point at
 * at least five sites and no single site carries half of them (Hacker News; not a blog or a mirror).
 */
export function isAggregator(urls: string[]): boolean {
  const counts = new Map<string, number>();
  for (const u of urls) {
    const h = siteOf(u);
    if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((s, n) => s + n, 0);
  if (counts.size < 5 || total === 0) return false;
  return Math.max(...counts.values()) / total < 0.5;
}
