// Discovery channels and pending-evidence signals (master design 3.2, 8.2 step 10; docs/discovery.md).
// Three channels feed discovery_signals: the directory (the first N directory feeds of the catalog,
// N = settings 'discovery'.feedCount, default 3), a project's pack (hot_signal feeds bound to that
// project) and a reader's lead (a URL typed on the project page). All are free: plain RSS without
// keys, or text the reader typed. Reading a channel stores signals only — no observation, no model
// call, no change to the feed's own source row — and a failed feed is counted, never retried here.
// The promotion gate is the pure promotionGate() of @topka/contracts/discovery; this module only
// gives it the saved observations to look at (editorial sources, not withdrawn) and writes its answer.
import { identityOf, MIRROR_HOSTS, normalizeCap, pendingList, promotionGate, type ChannelKind, type SignalStatus } from "@topka/contracts/discovery";
import { sql, type Db } from "../db.ts";
import { config } from "../config.ts";
import { shortHash } from "../lib/ids.ts";
import { fetchRss } from "../sources/rss.ts";
import type { SourceRow } from "../sources/types.ts";

export const SETTINGS_KEY = "discovery";
export const STATE_KEY = "discovery.state";
/** Directory feeds read by default (handover 2.9: production wires the first 3). */
export const DEFAULT_FEED_COUNT = 3;
export const MAX_FEED_COUNT = 20;
/** Entries read per feed per run, and how old an entry may be (by its own date) to count. */
export const ITEMS_PER_FEED = 20;
export const ITEM_MAX_AGE_DAYS = 14;
/** The gate looks at awaiting signals this recent, and observations from this long before them. */
export const GATE_SIGNAL_WINDOW_DAYS = 90;
export const GATE_OBSERVATION_LEAD_DAYS = 30;
/** A project keeps at most this many awaiting leads from its reader. */
export const MAX_AWAITING_LEADS = 200;
export const LIMITS = { url: 4096, title: 300, note: 1000, reason: 500 } as const;

export interface DiscoverySettings {
  feedCount: number;
}

export function normalizeFeedCount(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_FEED_COUNT ? raw : DEFAULT_FEED_COUNT;
}

export async function discoverySettings(db: Db = sql): Promise<DiscoverySettings> {
  const [row] = await db<{ value: Partial<DiscoverySettings> }[]>`SELECT value FROM settings WHERE key = ${SETTINGS_KEY}`;
  return { feedCount: normalizeFeedCount(row?.value?.feedCount) };
}

export async function saveDiscoverySettings(next: { feedCount: unknown }, actor: string, db: Db = sql): Promise<DiscoverySettings> {
  const value = { feedCount: normalizeFeedCount(next.feedCount) };
  await db`INSERT INTO settings (key, value, updated_by) VALUES (${SETTINGS_KEY}, ${db.json(value)}, ${actor})
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return value;
}

/** One id per (channel, project, url): the same entry seen again is the same signal. */
export function signalId(kind: ChannelKind, channelName: string, projectId: string | null, url: string): string {
  return `sig_${shortHash(`${kind}\u0001${channelName}\u0001${projectId ?? ""}\u0001${url.trim()}`, 24)}`;
}

export interface NewSignal {
  kind: ChannelKind;
  channelName: string;
  channelSourceId?: string | null;
  url: string;
  title?: string | null;
  note?: string | null;
  publishedAt?: Date | null;
  projectId?: string | null;
  submittedBy?: string | null;
  discoveredAt?: Date;
}

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, n) : null;
};

/** Stores a signal once; true when it is new. */
export async function recordSignal(s: NewSignal, db: Db = sql): Promise<{ id: string; created: boolean }> {
  const url = s.url.trim().slice(0, LIMITS.url);
  const name = s.channelName.trim().slice(0, 200);
  const id = signalId(s.kind, name, s.projectId ?? null, url);
  const rows = await db`
    INSERT INTO discovery_signals (id, channel_kind, channel_name, channel_source_id, url, url_identity, title, note,
                                   discovered_at, published_at_claim, project_id, submitted_by)
    VALUES (${id}, ${s.kind}, ${name}, ${s.channelSourceId ?? null}, ${url}, ${identityOf(url)},
            ${clip(s.title, LIMITS.title)}, ${clip(s.note, LIMITS.note)}, ${s.discoveredAt ?? new Date()},
            ${s.publishedAt && Number.isFinite(s.publishedAt.getTime()) ? s.publishedAt : null}, ${s.projectId ?? null}, ${s.submittedBy ?? null})
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  return { id, created: rows.length > 0 };
}

// --- channels -------------------------------------------------------------------------------------

interface ChannelFeed {
  source: SourceRow;
  kind: ChannelKind;
  projectId: string | null;
}

/** The directory feeds read now: the first feedCount of the catalog (directory-tagged hot_signal RSS). */
export async function directoryFeeds(feedCount: number, db: Db = sql): Promise<SourceRow[]> {
  if (feedCount <= 0) return [];
  return db<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, NULL::jsonb AS cursor, fail_count
    FROM sources WHERE participation_mode = 'hot_signal' AND kind = 'rss' AND 'directory' = ANY(tags)
    ORDER BY created_at, id LIMIT ${feedCount}`;
}

/** Pack feeds: hot_signal RSS sources a live project follows (its pack's discovery feeds). */
async function packFeeds(db: Db): Promise<ChannelFeed[]> {
  const rows = await db<(SourceRow & { project_id: string })[]>`
    SELECT s.id, s.name, s.kind, s.config, s.tier, s.participation_mode, s.first_party, s.interval_minutes, s.enabled, NULL::jsonb AS cursor, s.fail_count,
           ps.project_id
    FROM project_sources ps JOIN sources s ON s.id = ps.source_id JOIN tracking_projects p ON p.id = ps.project_id
    WHERE s.participation_mode = 'hot_signal' AND s.kind = 'rss' AND NOT ps.paused AND p.status = 'active'
    ORDER BY ps.project_id, s.id`;
  return rows.map(({ project_id, ...source }) => ({ source: source as SourceRow, kind: "pack" as const, projectId: project_id }));
}

export interface ChannelReadResult {
  feeds: number;
  failed: number;
  found: number;
  created: number;
  fromHeat: number;
  gate: GateRunResult;
}

type FeedReader = (source: SourceRow) => Promise<Array<{ url: string; title: string; publishedAt?: Date | null }>>;
const readFeed: FeedReader = async (source) => (await fetchRss({ ...source, cursor: null }, { force: true })).candidates;

/** Reads every channel once, stores new signals, then runs the gate. */
export async function collectDiscoveryChannels(opts: { reader?: FeedReader; db?: Db; now?: Date } = {}): Promise<ChannelReadResult> {
  const db = opts.db ?? sql;
  const reader = opts.reader ?? readFeed;
  const now = opts.now ?? new Date();
  const out: ChannelReadResult = { feeds: 0, failed: 0, found: 0, created: 0, fromHeat: 0, gate: { checked: 0, promoted: 0, observations: 0 } };
  if (!config.discoveryEnabled || process.env.COLLECT_ENABLED === "false") {
    out.gate = await runPromotionGate({ db });
    return out;
  }
  const { feedCount } = await discoverySettings(db);
  const feeds: ChannelFeed[] = [
    ...(await directoryFeeds(feedCount, db)).map((source) => ({ source, kind: "directory" as const, projectId: null })),
    ...(await packFeeds(db)),
  ];
  const state: Record<string, { at: string; ok: boolean; found: number; created: number; error?: string }> = {};
  const cutoff = now.getTime() - ITEM_MAX_AGE_DAYS * 86400_000;
  for (const f of feeds) {
    out.feeds += 1;
    try {
      const items = (await reader(f.source))
        .filter((c) => !c.publishedAt || !Number.isFinite(c.publishedAt.getTime()) || c.publishedAt.getTime() >= cutoff)
        .slice(0, ITEMS_PER_FEED);
      let created = 0;
      for (const c of items) {
        const r = await recordSignal({ kind: f.kind, channelName: f.source.name, channelSourceId: f.source.id, url: c.url, title: c.title, publishedAt: c.publishedAt ?? null, projectId: f.projectId }, db);
        if (r.created) created += 1;
      }
      out.found += items.length;
      out.created += created;
      state[`${f.kind}:${f.projectId ?? ""}:${f.source.id}`] = { at: now.toISOString(), ok: true, found: items.length, created };
    } catch (error) {
      out.failed += 1;
      state[`${f.kind}:${f.projectId ?? ""}:${f.source.id}`] = { at: now.toISOString(), ok: false, found: 0, created: 0, error: String((error as Error)?.message ?? error).slice(0, 200) };
    }
  }
  // Directory feeds the collector already reads for heat (enabled hot_signal sources): their recent
  // entries are directory signals too, without a second fetch.
  const heat = await db<{ source_id: string; name: string; url: string; title: string; published_at: Date | null; discovered_at: Date }[]>`
    SELECT s.id AS source_id, s.name, a.url, a.title, a.published_at, a.discovered_at
    FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE s.participation_mode = 'hot_signal' AND s.enabled AND a.discovered_at > ${new Date(now.getTime() - 48 * 3600_000)}
    ORDER BY a.discovered_at, a.id LIMIT 500`;
  for (const h of heat) {
    const r = await recordSignal({ kind: "directory", channelName: h.name, channelSourceId: h.source_id, url: h.url, title: h.title, publishedAt: h.published_at, discoveredAt: h.discovered_at }, db);
    if (r.created) out.fromHeat += 1;
  }
  await db`INSERT INTO settings (key, value, updated_by) VALUES (${STATE_KEY}, ${db.json({ at: now.toISOString(), feeds: state } as never)}, 'discovery')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  out.gate = await runPromotionGate({ db });
  return out;
}

// --- the gate -------------------------------------------------------------------------------------

export interface GateRunResult {
  checked: number;
  promoted: number;
  observations: number;
}

function hostOf(identity: string): string | null {
  try {
    return new URL(identity).hostname;
  } catch {
    return null;
  }
}

/** Hosts whose observations could share an identity with these: the host and its mirrors. */
function candidateHosts(identities: string[]): string[] {
  const hosts = new Set<string>();
  for (const id of identities) {
    const h = hostOf(id);
    if (!h) continue;
    hosts.add(h);
    for (const [mirror, canonical] of Object.entries(MIRROR_HOSTS)) if (canonical === h) hosts.add(mirror);
    if (h === "www.youtube.com") hosts.add("youtu.be");
  }
  return [...hosts];
}

/**
 * Promotes the awaiting signals whose URL identity a saved observation shares. Saved observation:
 * an article of an editorial source (a directory or pack item cannot confirm itself; an isolated
 * source is not evidence) that is not withdrawn. Its addresses: the article URL and its feed guid.
 */
export async function runPromotionGate(opts: { db?: Db; signalIds?: string[] } = {}): Promise<GateRunResult> {
  const db = opts.db ?? sql;
  const signals = await db<{ id: string; url: string; url_identity: string; discovered_at: Date }[]>`
    SELECT id, url, url_identity, discovered_at FROM discovery_signals
    WHERE status = 'awaiting' AND url_identity IS NOT NULL
      ${opts.signalIds ? db`AND id IN ${db(opts.signalIds.length ? opts.signalIds : [""])}` : db`AND discovered_at > now() - make_interval(days => ${GATE_SIGNAL_WINDOW_DAYS})`}`;
  if (!signals.length) return { checked: 0, promoted: 0, observations: 0 };
  const hosts = candidateHosts(signals.map((s) => s.url_identity));
  const since = new Date(Math.min(...signals.map((s) => s.discovered_at.getTime())) - GATE_OBSERVATION_LEAD_DAYS * 86400_000);
  const observations = hosts.length ? await db<{ id: string; url: string; guid: string | null; captured_at: Date }[]>`
    SELECT a.id, a.url, a.raw->>'guid' AS guid, a.discovered_at AS captured_at
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN article_withdrawal_state w ON w.article_id = a.id
    WHERE s.participation_mode = 'editorial' AND coalesce(w.withdrawn, false) = false AND a.discovered_at >= ${since}
      AND (lower(substring(a.url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/@]*@)?([^/:?#]+)')) IN ${db(hosts)}
        OR lower(substring(a.raw->>'guid' from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/@]*@)?([^/:?#]+)')) IN ${db(hosts)})` : [];
  const result = promotionGate(
    signals.map((s) => ({ id: s.id, url: s.url, discoveredAtUtc: s.discovered_at.toISOString() })),
    observations.map((o) => ({ id: o.id, urls: o.guid && o.guid !== o.url ? [o.url, o.guid] : [o.url], capturedAtUtc: o.captured_at.toISOString() })),
  );
  let promoted = 0;
  for (const p of result.promoted) {
    const rows = await db`UPDATE discovery_signals SET status = 'promoted', promoted_observation_id = ${p.observationId}, promoted_at = now()
                          WHERE id = ${p.signalId} AND status = 'awaiting' RETURNING id`;
    promoted += rows.length;
  }
  return { checked: signals.length, promoted, observations: observations.length };
}

// --- reading --------------------------------------------------------------------------------------

export interface SignalView {
  id: string;
  kind: ChannelKind;
  channelName: string;
  url: string;
  title: string | null;
  note: string | null;
  discoveredAt: string;
  publishedAt: string | null;
  status: SignalStatus;
  projectId: string | null;
  /** No URL identity: shown, never promoted. */
  invalidUrl: boolean;
  duplicates?: number;
}

export interface PromotionView extends SignalView {
  promotedAt: string;
  observation: { id: string; title: string; url: string; sourceName: string } | null;
}

interface Row {
  id: string; channel_kind: ChannelKind; channel_name: string; url: string; url_identity: string | null; title: string | null; note: string | null;
  discovered_at: Date; published_at_claim: Date | null; status: SignalStatus; project_id: string | null;
}

const view = (r: Row): SignalView => ({
  id: r.id, kind: r.channel_kind, channelName: r.channel_name, url: r.url, title: r.title, note: r.note,
  discoveredAt: r.discovered_at.toISOString(), publishedAt: r.published_at_claim?.toISOString() ?? null,
  status: r.status, projectId: r.project_id, invalidUrl: !r.url_identity,
});

/** Signals a reader may see: the directory's, and the pack and lead signals of their own projects. */
type Scope = { kind: "site"; projectIds: string[] } | { kind: "project"; projectId: string } | { kind: "admin" };

function scopeFilter(db: Db, scope: Scope) {
  if (scope.kind === "admin") return db`TRUE`;
  if (scope.kind === "project") return db`project_id = ${scope.projectId}`;
  return scope.projectIds.length ? db`(project_id IS NULL OR project_id IN ${db(scope.projectIds)})` : db`project_id IS NULL`;
}

/** The capped, folded, ordered pending list of a scope (at most 2000 rows are read). */
export async function pendingSignals(scope: Scope, cap?: unknown, db: Db = sql) {
  const rows = await db<Row[]>`
    SELECT id, channel_kind, channel_name, url, url_identity, title, note, discovered_at, published_at_claim, status, project_id
    FROM discovery_signals WHERE status = 'awaiting' AND ${scopeFilter(db, scope)}
    ORDER BY discovered_at DESC, id LIMIT 2000`;
  const list = pendingList(rows.map((r) => ({ ...view(r), discoveredAtUtc: r.discovered_at.toISOString() })), normalizeCap(cap));
  return {
    items: list.items.map(({ discoveredAtUtc: _d, identity: _i, ...s }) => s),
    total: list.total,
    hidden: list.hidden,
    cap: list.cap,
  };
}

/** Promotion lineage of a scope, newest first. */
export async function promotions(scope: Scope, limit = 20, db: Db = sql): Promise<PromotionView[]> {
  const rows = await db<(Row & { promoted_at: Date; obs_id: string | null; obs_title: string | null; obs_url: string | null; obs_source: string | null })[]>`
    SELECT d.id, d.channel_kind, d.channel_name, d.url, d.url_identity, d.title, d.note, d.discovered_at, d.published_at_claim, d.status, d.project_id,
           d.promoted_at, a.id AS obs_id, a.title AS obs_title, a.url AS obs_url, s.name AS obs_source
    FROM discovery_signals d LEFT JOIN articles a ON a.id = d.promoted_observation_id LEFT JOIN sources s ON s.id = a.source_id
    WHERE d.status = 'promoted' AND ${scopeFilter(db, scope)}
    ORDER BY d.promoted_at DESC, d.id LIMIT ${Math.max(1, Math.min(100, limit))}`;
  return rows.map((r) => ({
    ...view(r),
    promotedAt: r.promoted_at.toISOString(),
    observation: r.obs_id ? { id: r.obs_id, title: r.obs_title ?? "", url: r.obs_url ?? "", sourceName: r.obs_source ?? "" } : null,
  }));
}

/** Lineage lines for observations: "confirmed a channel signal". */
export async function promotedFor(observationIds: string[], db: Db = sql): Promise<Map<string, Array<{ channelName: string; url: string; kind: ChannelKind }>>> {
  const out = new Map<string, Array<{ channelName: string; url: string; kind: ChannelKind }>>();
  if (!observationIds.length) return out;
  const rows = await db<{ promoted_observation_id: string; channel_name: string; url: string; channel_kind: ChannelKind }[]>`
    SELECT promoted_observation_id, channel_name, url, channel_kind FROM discovery_signals
    WHERE status = 'promoted' AND promoted_observation_id IN ${db(observationIds)} ORDER BY promoted_at, id`;
  for (const r of rows) out.set(r.promoted_observation_id, [...(out.get(r.promoted_observation_id) ?? []), { channelName: r.channel_name, url: r.url, kind: r.channel_kind }]);
  return out;
}

/** The directory catalog: every directory feed, the ones read now first, with their last read. */
export async function directoryCatalog(db: Db = sql) {
  const { feedCount } = await discoverySettings(db);
  const [state] = await db<{ value: { at?: string; feeds?: Record<string, { at: string; ok: boolean; found: number; created: number; error?: string }> } }[]>`SELECT value FROM settings WHERE key = ${STATE_KEY}`;
  const rows = await db<{ id: string; name: string; feed_url: string | null; enabled: boolean }[]>`
    SELECT id, name, config->>'feedUrl' AS feed_url, enabled FROM sources
    WHERE participation_mode = 'hot_signal' AND kind = 'rss' AND 'directory' = ANY(tags) ORDER BY created_at, id`;
  const [counts] = await db<{ awaiting: number; promoted: number; dismissed: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'awaiting')::int AS awaiting, count(*) FILTER (WHERE status = 'promoted')::int AS promoted,
           count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed FROM discovery_signals WHERE project_id IS NULL`;
  return {
    feedCount,
    enabled: config.discoveryEnabled && process.env.COLLECT_ENABLED !== "false",
    lastRunAt: state?.value?.at ?? null,
    total: rows.length,
    counts: counts ?? { awaiting: 0, promoted: 0, dismissed: 0 },
    feeds: rows.map((r, i) => {
      const last = state?.value?.feeds?.[`directory::${r.id}`];
      return { id: r.id, name: r.name, feedUrl: r.feed_url, active: i < feedCount, lastRead: last ? { at: last.at, ok: last.ok, found: last.found, error: last.error ?? null } : null };
    }),
  };
}

// --- reader leads and dismissals ------------------------------------------------------------------

export class LeadRejected extends Error {
  readonly code: "url-required" | "too-long" | "too-many";
  constructor(code: "url-required" | "too-long" | "too-many") {
    super(code);
    this.code = code;
  }
}

/** A reader's lead for their project: stored even when the URL has no identity (shown, never promoted). */
export async function addLead(projectId: string, userId: string, input: { url?: unknown; title?: unknown; note?: unknown }, db: Db = sql) {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) throw new LeadRejected("url-required");
  const title = typeof input.title === "string" ? input.title : "";
  const note = typeof input.note === "string" ? input.note : "";
  if (url.length > LIMITS.url || title.length > LIMITS.title || note.length > LIMITS.note) throw new LeadRejected("too-long");
  const [{ n }] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM discovery_signals WHERE project_id = ${projectId} AND channel_kind = 'user-lead' AND status = 'awaiting'`;
  if (n >= MAX_AWAITING_LEADS) throw new LeadRejected("too-many");
  const { id, created } = await recordSignal({ kind: "user-lead", channelName: "reader", url, title, note, projectId, submittedBy: userId }, db);
  const gate = await runPromotionGate({ db, signalIds: [id] });
  const [row] = await db<Row[]>`SELECT id, channel_kind, channel_name, url, url_identity, title, note, discovered_at, published_at_claim, status, project_id FROM discovery_signals WHERE id = ${id}`;
  return { signal: view(row!), created, promoted: gate.promoted > 0 };
}

/** Dismiss an awaiting signal (a project owner: only their project's; an operator: any). */
export async function dismissSignal(id: string, actor: string, reason: string, opts: { projectId?: string } = {}, db: Db = sql): Promise<SignalView | null> {
  const [row] = await db<Row[]>`
    UPDATE discovery_signals SET status = 'dismissed', dismissed_at = now(), dismissed_by = ${actor}, dismissed_reason = ${reason.trim().slice(0, LIMITS.reason) || null}
    WHERE id = ${id} AND status = 'awaiting' ${opts.projectId ? db`AND project_id = ${opts.projectId}` : db``}
    RETURNING id, channel_kind, channel_name, url, url_identity, title, note, discovered_at, published_at_claim, status, project_id`;
  return row ? view(row) : null;
}

export async function restoreSignal(id: string, db: Db = sql): Promise<SignalView | null> {
  const [row] = await db<Row[]>`
    UPDATE discovery_signals SET status = 'awaiting', dismissed_at = NULL, dismissed_by = NULL, dismissed_reason = NULL
    WHERE id = ${id} AND status = 'dismissed'
    RETURNING id, channel_kind, channel_name, url, url_identity, title, note, discovered_at, published_at_claim, status, project_id`;
  if (row) await runPromotionGate({ db, signalIds: [id] });
  return row ? view(row) : null;
}

/** The operator's list: every signal, filtered by status and channel, 100 per page. */
export async function adminSignals(q: { status?: string; kind?: string; page?: number }, db: Db = sql) {
  const status = ["awaiting", "promoted", "dismissed"].includes(q.status ?? "") ? q.status! : null;
  const kind = ["directory", "pack", "user-lead"].includes(q.kind ?? "") ? q.kind! : null;
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const rows = await db<(Row & { promoted_observation_id: string | null; promoted_at: Date | null; dismissed_reason: string | null; dismissed_by: string | null })[]>`
    SELECT id, channel_kind, channel_name, url, url_identity, title, note, discovered_at, published_at_claim, status, project_id,
           promoted_observation_id, promoted_at, dismissed_reason, dismissed_by
    FROM discovery_signals
    WHERE ${status ? db`status = ${status}` : db`TRUE`} AND ${kind ? db`channel_kind = ${kind}` : db`TRUE`}
    ORDER BY discovered_at DESC, id LIMIT 100 OFFSET ${(page - 1) * 100}`;
  const counts = await db<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM discovery_signals GROUP BY status`;
  return {
    page,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    rows: rows.map((r) => ({ ...view(r), promotedObservationId: r.promoted_observation_id, promotedAt: r.promoted_at?.toISOString() ?? null, dismissedReason: r.dismissed_reason, dismissedBy: r.dismissed_by })),
    catalog: await directoryCatalog(db),
  };
}
