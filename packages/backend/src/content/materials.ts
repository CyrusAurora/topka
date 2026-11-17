// The single entrance for new material from every channel (collectors, external reports, imports).
// It owns identity, revisions and the timeline rule, so no entrance can bypass them.
import { sql, type Db, type Tx } from "../db.ts";
import { newArticleId, sha256 } from "../lib/ids.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { collapseWhitespace } from "../lib/text.ts";

export interface MediaItem {
  kind: "image" | "video";
  url: string;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
  poster?: string | null;
}

export interface XPostData {
  tweetId: string;
  authorName: string;
  handle: string;
  avatarUrl?: string | null;
  text: string;
  quoted?: { authorName: string; handle: string; text: string; url: string; media?: MediaItem[] } | null;
  media?: MediaItem[];
  lang?: string | null;
  replyTo?: string | null;
}

export interface MaterialInput {
  sourceId: string;
  url: string;
  title: string;
  identityKey?: string;
  author?: string | null;
  language?: string | null;
  publishedAt?: Date | null;
  sourceUpdatedAt?: Date | null;
  excerpt?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  bodyStatus?: "pending" | "ok" | "unconfirmed" | "none";
  media?: MediaItem[];
  xPost?: XPostData | null;
  raw?: unknown;
  via: "fetch" | "ingest" | "import";
  discoveredAt?: Date;
  /** Explicit backfill: first import of a new source, or a report flagged as backfill. */
  backfill?: string | null;
  /** Keep an existing id when importing history. */
  id?: string;
}

/**
 * The four outcomes of a report (master design 3.3), and nothing else:
 * - created: a new observation was recorded: a new material, or (`changed`) a later version of a known
 *   one, appended as its next revision (a correction; the earlier versions stay in article_revisions);
 * - existing: the ledger already holds exactly this (another source listing it is a discovery only);
 * - conflict: the report claims to be this observation but is not a successor of what is stored (an
 *   older version of the source showing other content); refused, nothing overwritten, the reported
 *   text kept in observation_rejections so the conflicting original can be opened (`identity-conflict`);
 * - failed: the report or the write is not trustworthy (a typed failure, never repaired silently):
 *   `missing-provenance` (no source, an unknown source, no http(s) URL) or `preservation-failed` (what
 *   was written did not read back the same).
 */
export type LedgerState = "created" | "existing" | "conflict" | "failed";
export type LedgerCode = "identity-conflict" | "missing-provenance" | "preservation-failed";

export interface MaterialResult {
  state: LedgerState;
  /** created only: a later version of an observation already in the ledger. */
  changed: boolean;
  /** conflict and failed only. */
  code: LedgerCode | null;
  /** The observation the report is about; null when nothing was stored (failed). */
  articleId: string | null;
  /** state = created and not changed (a new material). */
  created: boolean;
  /** state = created and changed (a new revision). */
  revised: boolean;
  backfill: boolean;
}

export type LedgerCounts = Record<"created" | "changed" | "existing" | "conflict" | "failed", number>;
export const emptyLedgerCounts = (): LedgerCounts => ({ created: 0, changed: 0, existing: 0, conflict: 0, failed: 0 });
/** Adds one outcome to a run's counts (fetch_runs.detail.ledger, the ingest answer). */
export function countOutcome(counts: LedgerCounts, r: MaterialResult): LedgerCounts {
  counts[r.state === "created" && r.changed ? "changed" : r.state] += 1;
  return counts;
}

const outcome = (state: LedgerState, articleId: string | null, backfill: boolean, extra: { changed?: boolean; code?: LedgerCode } = {}): MaterialResult => ({
  state, changed: extra.changed ?? false, code: extra.code ?? null, articleId, backfill,
  created: state === "created" && !extra.changed, revised: state === "created" && !!extra.changed,
});

/** Thrown inside the write transaction when the stored row does not read back as written. */
class PreservationFailed extends Error {}

// Material first discovered more than this long after its source time is archived by source time,
// stays out of "today" and is never pushed. Must not be wider than the 72 h the v1 contract states.
export const STALE_ON_DISCOVERY_MS = 48 * 3600 * 1000;
// Source times more than an hour in the future are not trusted.
export const FUTURE_TOLERANCE_MS = 3600 * 1000;

export interface TimelineDecision {
  publishedAt: Date | null;
  timelineAt: Date;
  backfill: boolean;
  backfillReason: string | null;
}

/** The one timeline rule shared by every entrance. */
export function decideTimeline(claimed: Date | null | undefined, discoveredAt: Date, explicitBackfill?: string | null): TimelineDecision {
  let publishedAt: Date | null = claimed && Number.isFinite(claimed.getTime()) ? claimed : null;
  if (publishedAt && publishedAt.getTime() > discoveredAt.getTime() + FUTURE_TOLERANCE_MS) publishedAt = null;
  let backfillReason: string | null = null;
  if (explicitBackfill) backfillReason = explicitBackfill;
  else if (publishedAt && discoveredAt.getTime() - publishedAt.getTime() > STALE_ON_DISCOVERY_MS) backfillReason = "stale-on-discovery";
  const backfill = backfillReason !== null;
  const timelineAt = backfill && publishedAt ? publishedAt : discoveredAt;
  return { publishedAt, timelineAt, backfill, backfillReason };
}

/**
 * History rather than news: a backfill (a new source's first import, stale on discovery, flagged by
 * a report) whose source time is unknown or was already past the stale threshold when found. It is
 * archived and analysed like anything else, but waits behind live work and founds no event and adds
 * no heat (it stays out of the event graph). A new source's post from this morning is news.
 */
export function isHistorical(a: { backfill: boolean; published_at: Date | null; discovered_at: Date }): boolean {
  return a.backfill && (!a.published_at || a.discovered_at.getTime() - a.published_at.getTime() > STALE_ON_DISCOVERY_MS);
}

/** Identity of stored content: the revision changes exactly when this does. */
export function contentHash(c: { title: string; bodyText?: string | null; excerpt?: string | null }): string {
  return sha256([collapseWhitespace(c.title), collapseWhitespace(c.bodyText ?? ""), collapseWhitespace(c.excerpt ?? "")].join("\u0001"));
}

const LOST = "\uFFFD";

/**
 * Whether two renderings of a text differ only where a character was lost in transit: a U+FFFD (a run
 * of them, from an older decode) on either side stands for any one character. Some feeds garble a
 * few characters at random on every load, so no two loads of its articles are the same text.
 */
function sameBarringLoss(a: string | null | undefined, b: string | null | undefined): boolean {
  const chars = (s: string | null | undefined) => Array.from(collapseWhitespace(s ?? "").replace(/\uFFFD+/g, LOST));
  const x = chars(a);
  const y = chars(b);
  return x.length === y.length && x.every((c, i) => c === y[i] || c === LOST || y[i] === LOST);
}

export function identityKeyFor(m: MaterialInput): string {
  if (m.identityKey) return m.identityKey;
  if (m.xPost?.tweetId) return `x:${m.xPost.tweetId}`;
  const fromUrl = identityKeyForUrl(m.url);
  if (fromUrl) return fromUrl;
  return `src:${m.sourceId}:${sha256(m.url + "\u0001" + m.title).slice(0, 32)}`;
}

/** A report that names where it came from: a source and an absolute http(s) URL. */
function hasProvenance(m: MaterialInput): boolean {
  if (!m.sourceId?.trim()) return false;
  try {
    const u = new URL(m.url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

interface Rejection {
  state: "conflict" | "failed";
  code: LedgerCode;
  m: MaterialInput;
  identityKey: string | null;
  articleId?: string | null;
  hash?: string | null;
  storedRevision?: number | null;
  storedMarker?: Date | null;
  detail?: string;
}

/** Appends a refused report to observation_rejections (the same report again is kept once). */
async function recordRejection(db: Db, r: Rejection) {
  const sourceId = r.m.sourceId?.trim() ? r.m.sourceId : null;
  await db`
    INSERT INTO observation_rejections (state, code, source_id, article_id, identity_key, url, title, excerpt, body_text, content_hash,
      version_marker, stored_revision, stored_marker, via, detail)
    VALUES (${r.state}, ${r.code}, ${sourceId}, ${r.articleId ?? null}, ${r.identityKey}, ${String(r.m.url ?? "").slice(0, 2000)},
      ${String(r.m.title ?? "").slice(0, 1000)}, ${r.m.excerpt ?? null}, ${r.m.bodyText ?? null}, ${r.hash ?? null},
      ${r.m.sourceUpdatedAt ?? null}, ${r.storedRevision ?? null}, ${r.storedMarker ?? null}, ${r.m.via}, ${(r.detail ?? "").slice(0, 1000)})
    ON CONFLICT DO NOTHING`;
}

export class MaterialRefused extends Error {
  readonly result: MaterialResult;
  constructor(result: MaterialResult) {
    super(`material refused: ${result.state} (${result.code})`);
    this.result = result;
  }
}

/** recordMaterial for callers that cannot go on without the stored observation: a refusal throws. */
export async function upsertMaterial(m: MaterialInput, db: Db = sql): Promise<MaterialResult & { articleId: string }> {
  const r = await recordMaterial(m, db);
  if (r.state === "failed" || r.articleId === null) throw new MaterialRefused(r);
  return r as MaterialResult & { articleId: string };
}

/**
 * Stores material. Existing identities get a discovery record, and a new revision only when the
 * stored content really changes. Concurrent reports of the same material are serialised on the row,
 * so every change gets its own revision number. The outcome is one of the four ledger states; a
 * refused report (conflict, failed) is recorded in observation_rejections.
 */
export async function recordMaterial(m: MaterialInput, db: Db = sql): Promise<MaterialResult> {
  if (!hasProvenance(m)) {
    await recordRejection(db, { state: "failed", code: "missing-provenance", m, identityKey: null, detail: "a report needs a source and an absolute http(s) URL" });
    return outcome("failed", null, false, { code: "missing-provenance" });
  }
  const run = (tx: Db) => upsertIn(tx, m);
  try {
    if ("begin" in db) return await (db as typeof sql).begin(run);
    return await (db as Tx).savepoint(run);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // An unknown source (foreign key) is a report without provenance; a read-back mismatch is a failed preservation.
    if (code === "23503" && /source/.test(String((error as { constraint_name?: string }).constraint_name ?? (error as Error).message))) {
      await recordRejection(db, { state: "failed", code: "missing-provenance", m, identityKey: identityKeyFor(m), detail: `unknown source ${m.sourceId}` });
      return outcome("failed", null, false, { code: "missing-provenance" });
    }
    if (error instanceof PreservationFailed) {
      await recordRejection(db, { state: "failed", code: "preservation-failed", m, identityKey: identityKeyFor(m), detail: error.message });
      return outcome("failed", null, false, { code: "preservation-failed" });
    }
    throw error;
  }
}

/** The write's self-check: inside the transaction, the row reads back with what was meant to be written. */
async function readBack(db: Db, id: string, want: { sourceId: string; title: string; bodyText: string | null; hash: string; revision?: number }) {
  const [back] = await db<{ source_id: string; title: string; body_text: string | null; content_hash: string | null; revision: number }[]>`
    SELECT source_id, title, body_text, content_hash, revision FROM articles WHERE id = ${id}`;
  const [rev] = back ? await db<{ content_hash: string | null; title: string }[]>`
    SELECT content_hash, title FROM article_revisions WHERE article_id = ${id} AND revision = ${back.revision}` : [];
  const wrong = !back ? ["row"] : [
    back.source_id !== want.sourceId && "source_id",
    back.title !== want.title && "title",
    back.body_text !== want.bodyText && "body_text",
    back.content_hash !== want.hash && "content_hash",
    want.revision !== undefined && back.revision !== want.revision && "revision",
    (!rev || rev.content_hash !== want.hash || rev.title !== want.title) && "article_revisions",
  ].filter(Boolean);
  if (wrong.length) throw new PreservationFailed(`article ${id} read back with a different ${wrong.join(", ")}`);
}

async function upsertIn(db: Db, m: MaterialInput): Promise<MaterialResult> {
  const identityKey = identityKeyFor(m);
  const discoveredAt = m.discoveredAt ?? new Date();
  const title = collapseWhitespace(m.title).slice(0, 1000) || m.url;

  const t = decideTimeline(m.publishedAt, discoveredAt, m.backfill);
  const newId = m.id ?? newArticleId();
  const hash = contentHash({ title, bodyText: m.bodyText, excerpt: m.excerpt });
  const [inserted] = await db<{ id: string }[]>`
    INSERT INTO articles (id, source_id, identity_key, url, title, author, language, published_at, published_at_claim,
      discovered_at, source_updated_at, timeline_at, backfill, backfill_reason, revision, content_hash, excerpt,
      body_text, body_html, body_status, media, x_post, raw)
    VALUES (${newId}, ${m.sourceId}, ${identityKey}, ${m.url}, ${title}, ${m.author ?? null}, ${m.language ?? null},
      ${t.publishedAt}, ${m.publishedAt ?? null}, ${discoveredAt}, ${m.sourceUpdatedAt ?? null}, ${t.timelineAt},
      ${t.backfill}, ${t.backfillReason}, 1, ${hash}, ${m.excerpt ?? null}, ${m.bodyText ?? null}, ${m.bodyHtml ?? null},
      ${m.bodyStatus ?? (m.bodyText ? "ok" : "pending")}, ${db.json((m.media ?? []) as never)},
      ${m.xPost ? db.json(m.xPost as never) : null}, ${m.raw === undefined ? null : db.json(m.raw as never)})
    ON CONFLICT (identity_key) DO NOTHING RETURNING id`;
  if (inserted) {
    await db`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text, version_marker)
             VALUES (${newId}, 1, ${hash}, ${title}, ${m.bodyText ?? null}, ${m.sourceUpdatedAt ?? null})`;
    await db`INSERT INTO article_discoveries (article_id, source_id, via, discovered_at)
             VALUES (${newId}, ${m.sourceId}, ${m.via}, ${discoveredAt}) ON CONFLICT DO NOTHING`;
    await readBack(db, newId, { sourceId: m.sourceId, title, bodyText: m.bodyText ?? null, hash, revision: 1 });
    return outcome("created", newId, t.backfill);
  }

  const [existing] = await db<{ id: string; source_id: string; revision: number; content_hash: string | null; backfill: boolean; title: string; body_text: string | null; excerpt: string | null; source_updated_at: Date | null }[]>`
    SELECT id, source_id, revision, content_hash, backfill, title, body_text, excerpt, source_updated_at FROM articles WHERE identity_key = ${identityKey} FOR UPDATE`;
  await db`INSERT INTO article_discoveries (article_id, source_id, via, discovered_at)
           VALUES (${existing!.id}, ${m.sourceId}, ${m.via}, ${discoveredAt}) ON CONFLICT DO NOTHING`;
  const unchanged = outcome("existing", existing!.id, existing!.backfill);
  // Another source listing the same material (an aggregator, a translated mirror, a hot signal) is a
  // discovery only: its title and summary are its own rendering, and taking them made the article flip
  // between the two sources' versions on every fetch. Only the article's own source revises it.
  if (existing!.source_id !== m.sourceId) return unchanged;
  // What the row will hold after this report: a listing without body keeps the stored (extracted) body.
  const bodyText = m.bodyText ?? existing!.body_text;
  const excerpt = m.excerpt ?? existing!.excerpt;
  const next = contentHash({ title, bodyText, excerpt });
  if (existing!.content_hash === next) return unchanged;
  if (existing!.content_hash === null) {
    // Imported history carries no hash of this form (its collectors normalised differently): the
    // first report here records the baseline instead of a revision, so an import does not send
    // every article a source still lists back to paid analysis. The baseline joins the history, so
    // a later return to it is recognised as a version seen before.
    await db`UPDATE articles SET content_hash = ${next}, excerpt = coalesce(excerpt, ${m.excerpt ?? null}) WHERE id = ${existing!.id}`;
    await db`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text, version_marker)
             VALUES (${existing!.id}, ${existing!.revision}, ${next}, ${title}, ${bodyText}, ${m.sourceUpdatedAt ?? null}) ON CONFLICT DO NOTHING`;
    return unchanged;
  }
  // A version this article already had is no new material (listings that alternate between two
  // renderings, pages that rotate promotions): the current revision was analysed and published once
  // already. Any earlier version counts, however long ago: a rotation with many variants would
  // otherwise start over, and a real edit reverted later is rare and loses nothing.
  const [seen] = await db`SELECT 1 FROM article_revisions WHERE article_id = ${existing!.id} AND content_hash = ${next} LIMIT 1`;
  if (seen) return unchanged;
  // Nor is the stored version with other characters lost in transit, or with them restored.
  if (sameBarringLoss(existing!.title, title) && sameBarringLoss(existing!.body_text, bodyText) && sameBarringLoss(existing!.excerpt, excerpt)) return unchanged;
  // New content under a version time older than the stored one is no successor: a stale copy (a
  // cache or mirror replaying an old state) must not become the current version. An equal time is
  // not a conflict: most feeds never move `updated` when they edit (97 of the 128 revised articles
  // with a version time in production, 2026-11), so equal or missing times are corrections.
  if (m.sourceUpdatedAt && existing!.source_updated_at && m.sourceUpdatedAt.getTime() < existing!.source_updated_at.getTime()) {
    await recordRejection(db, {
      state: "conflict", code: "identity-conflict", m, identityKey, articleId: existing!.id, hash: next,
      storedRevision: existing!.revision, storedMarker: existing!.source_updated_at,
      detail: "different content under an older version time than the stored revision",
    });
    return outcome("conflict", existing!.id, existing!.backfill, { code: "identity-conflict" });
  }

  const [row] = await db<{ revision: number }[]>`
    UPDATE articles SET
      title = ${title}, author = coalesce(${m.author ?? null}, author), language = coalesce(${m.language ?? null}, language),
      source_updated_at = ${m.sourceUpdatedAt ?? null}, excerpt = coalesce(${m.excerpt ?? null}, excerpt),
      body_text = coalesce(${m.bodyText ?? null}, body_text), body_html = coalesce(${m.bodyHtml ?? null}, body_html),
      body_status = CASE WHEN ${m.bodyText ?? null}::text IS NULL THEN body_status ELSE ${m.bodyStatus ?? "ok"} END,
      media = CASE WHEN ${m.media ? db.json(m.media as never) : null}::jsonb IS NULL THEN media ELSE ${m.media ? db.json(m.media as never) : null}::jsonb END,
      x_post = coalesce(${m.xPost ? db.json(m.xPost as never) : null}, x_post),
      revision = revision + 1, content_hash = ${next}, processing_state = 'new', updated_at = now()
    WHERE id = ${existing!.id}
    RETURNING revision`;
  await db`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text, version_marker)
           VALUES (${existing!.id}, ${row!.revision}, ${next}, ${title}, ${bodyText}, ${m.sourceUpdatedAt ?? null})`;
  await readBack(db, existing!.id, { sourceId: m.sourceId, title, bodyText, hash: next, revision: row!.revision });
  return outcome("created", existing!.id, existing!.backfill, { changed: true });
}
