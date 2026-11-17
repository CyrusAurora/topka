// Withdrawal and correction in the observation ledger (master design 3.3). A source retracting or
// removing material is a new record in article_withdrawals, never an edit or a delete of the
// observation; reinstating is another record, and the latest record is the state. A withdrawn
// observation stops being current evidence (it no longer enters a brief or an issue) but stays
// readable as retracted material. A correction is a later revision of the observation
// (article_revisions); what changed can always be opened, and so can a refused conflicting report.
import { sql, type Db } from "../db.ts";

export type WithdrawalBasis = "source-retracted" | "source-removed" | "editorial";
export const WITHDRAWAL_BASES: readonly WithdrawalBasis[] = ["source-retracted", "source-removed", "editorial"];

export interface WithdrawalInput {
  action: "withdraw" | "reinstate";
  basis: WithdrawalBasis;
  reason: string;
  evidenceUrl?: string | null;
  recordedBy: string;
}

export class WithdrawalInvalid extends Error {}

/**
 * Appends a withdrawal (or reinstatement) record. Returns recorded: false when the state already is
 * what was asked (withdrawing a withdrawn article, reinstating a current one): the record must change
 * the state, which the database also enforces.
 */
export async function recordWithdrawal(articleId: string, input: WithdrawalInput, db: Db = sql): Promise<{ recorded: boolean; withdrawn: boolean }> {
  const reason = input.reason?.trim();
  if (!reason) throw new WithdrawalInvalid("reason is required");
  if (!WITHDRAWAL_BASES.includes(input.basis)) throw new WithdrawalInvalid("unknown basis");
  if (input.action !== "withdraw" && input.action !== "reinstate") throw new WithdrawalInvalid("unknown action");
  const evidence = input.evidenceUrl?.trim() || null;
  if (evidence && !/^https?:\/\//i.test(evidence)) throw new WithdrawalInvalid("evidence must be an http(s) URL");
  const run = async (tx: Db) => {
    const [article] = await tx<{ id: string }[]>`SELECT id FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!article) return null;
    const [state] = await tx<{ withdrawn: boolean }[]>`SELECT withdrawn FROM article_withdrawal_state WHERE article_id = ${articleId}`;
    const withdrawn = state?.withdrawn ?? false;
    if ((input.action === "withdraw") === withdrawn) return { recorded: false, withdrawn };
    await tx`INSERT INTO article_withdrawals (article_id, action, basis, reason, evidence_url, recorded_by)
             VALUES (${articleId}, ${input.action}, ${input.basis}, ${reason.slice(0, 1000)}, ${evidence}, ${input.recordedBy})`;
    return { recorded: true, withdrawn: input.action === "withdraw" };
  };
  const out = "begin" in db ? await (db as typeof sql).begin(run) : await run(db);
  if (!out) throw new WithdrawalInvalid("no such article");
  return out;
}

/**
 * How an observation is presented: current; corrected (the source changed its title, or a body it
 * had already shown — filling in a body that was missing is no correction); or retracted material.
 */
export type LedgerPresentation = "current" | "corrected" | "retracted-material";

export interface LedgerView {
  state: LedgerPresentation;
  revision: number;
  /** Only for retracted material. */
  withdrawal: { basis: WithdrawalBasis; reason: string; at: string } | null;
}

export async function ledgerStates(articleIds: string[], db: Db = sql): Promise<Map<string, LedgerView>> {
  if (!articleIds.length) return new Map();
  const rows = await db<{ id: string; revision: number; corrected: boolean; withdrawn: boolean | null; basis: WithdrawalBasis | null; reason: string | null; at: Date | null }[]>`
    SELECT a.id, a.revision,
           EXISTS (SELECT 1 FROM article_revisions r WHERE r.article_id = a.id AND r.revision < a.revision
                     AND (r.title <> a.title OR (coalesce(r.body_text, '') <> '' AND r.body_text IS DISTINCT FROM a.body_text))) AS corrected,
           w.withdrawn, w.basis, w.reason, w.recorded_at AS at
    FROM articles a LEFT JOIN article_withdrawal_state w ON w.article_id = a.id
    WHERE a.id IN ${db(articleIds)}`;
  return new Map(rows.map((r) => [r.id, {
    state: r.withdrawn ? "retracted-material" : r.corrected ? "corrected" : "current",
    revision: r.revision,
    withdrawal: r.withdrawn ? { basis: r.basis!, reason: r.reason!, at: r.at!.toISOString() } : null,
  } satisfies LedgerView]));
}

export interface ArticleHistory {
  articleId: string;
  url: string;
  source: { id: string; name: string };
  state: LedgerView;
  /** Every version the source showed, oldest first. Titles and excerpts only: full text follows the source's licence. */
  revisions: Array<{ revision: number; title: string; contentHash: string | null; versionMarker: string | null; recordedAt: string }>;
  withdrawals: Array<{ action: "withdraw" | "reinstate"; basis: WithdrawalBasis; reason: string; evidenceUrl: string | null; recordedAt: string }>;
  /** Reports refused as conflicting with this observation, with what they showed. */
  conflicts: Array<{ title: string; excerpt: string | null; versionMarker: string | null; storedRevision: number | null; reportedAt: string }>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function articleHistory(articleId: string, db: Db = sql): Promise<ArticleHistory | null> {
  const [a] = await db<{ id: string; url: string; source_id: string; source_name: string }[]>`
    SELECT a.id, a.url, a.source_id, s.name AS source_name FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a) return null;
  const state = (await ledgerStates([articleId], db)).get(articleId)!;
  const revisions = await db<{ revision: number; title: string; content_hash: string | null; version_marker: Date | null; created_at: Date }[]>`
    SELECT revision, title, content_hash, version_marker, created_at FROM article_revisions WHERE article_id = ${articleId} ORDER BY revision, created_at`;
  const withdrawals = await db<{ action: "withdraw" | "reinstate"; basis: WithdrawalBasis; reason: string; evidence_url: string | null; recorded_at: Date }[]>`
    SELECT action, basis, reason, evidence_url, recorded_at FROM article_withdrawals WHERE article_id = ${articleId} ORDER BY id`;
  const conflicts = await db<{ title: string | null; excerpt: string | null; version_marker: Date | null; stored_revision: number | null; reported_at: Date }[]>`
    SELECT title, excerpt, version_marker, stored_revision, reported_at FROM observation_rejections
    WHERE article_id = ${articleId} AND state = 'conflict' ORDER BY id`;
  return {
    articleId: a.id, url: a.url, source: { id: a.source_id, name: a.source_name }, state,
    revisions: revisions.map((r) => ({ revision: r.revision, title: r.title, contentHash: r.content_hash, versionMarker: iso(r.version_marker), recordedAt: r.created_at.toISOString() })),
    withdrawals: withdrawals.map((w) => ({ action: w.action, basis: w.basis, reason: w.reason, evidenceUrl: w.evidence_url, recordedAt: w.recorded_at.toISOString() })),
    conflicts: conflicts.map((c) => ({ title: c.title ?? "", excerpt: c.excerpt, versionMarker: iso(c.version_marker), storedRevision: c.stored_revision, reportedAt: c.reported_at.toISOString() })),
  };
}

/** Whether the user follows the article (one of their projects links its source, or a source that also listed it). */
export async function userFollowsArticle(userId: string, articleId: string, db: Db = sql): Promise<boolean> {
  const [ok] = await db<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM articles a JOIN project_sources ps ON ps.source_id = a.source_id
      JOIN tracking_projects p ON p.id = ps.project_id AND p.owner_id = ${userId} WHERE a.id = ${articleId}
      UNION ALL
      SELECT 1 FROM article_discoveries d JOIN project_sources ps ON ps.source_id = d.source_id
      JOIN tracking_projects p ON p.id = ps.project_id AND p.owner_id = ${userId} WHERE d.article_id = ${articleId}
    ) AS ok`;
  return !!ok?.ok;
}
