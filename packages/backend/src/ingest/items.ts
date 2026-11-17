// External collection reports (docs/sources.md). Same identity rules and timeline
// rule as every other entrance: old or future-dated items and explicit backfill never count as
// today's news and are never pushed. Unknown sources are created isolated, awaiting an operator.
import { sql } from "../db.ts";
import { countOutcome, emptyLedgerCounts, identityKeyFor, recordMaterial, type LedgerCounts } from "../content/materials.ts";
import { recordWithdrawal } from "../content/withdrawals.ts";
import { publishArticle } from "../publication/publish.ts";
import { queueProcessing } from "../jobs/content.ts";
import { normalizeUrl } from "../lib/url.ts";

export const MAX_ITEMS = 50;

export class IngestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ItemIn {
  title?: unknown;
  url?: unknown;
  publishedAt?: unknown;
  author?: unknown;
  raw?: { _topka?: { backfill?: boolean; baseline?: boolean } } & Record<string, unknown>;
  /** The reporter saw the item removed at the source (a deleted post or page): a withdrawal record. */
  withdrawn?: unknown;
  withdrawnReason?: unknown;
}

export async function ingestItems(body: { sourceId?: unknown; sourceName?: unknown; items?: unknown }): Promise<{ ok: true; created: number; ledger: LedgerCounts; withdrawn: number }> {
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  const items = Array.isArray(body.items) ? (body.items as ItemIn[]) : [];
  if (!sourceId || !items.length) throw new IngestError(400, "sourceId and items[] required");
  if (items.length > MAX_ITEMS) throw new IngestError(413, `items[] exceeds max ${MAX_ITEMS} per request`);

  const [source] = await sql<{ id: string; participation_mode: string; enabled: boolean }[]>`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
    VALUES (${sourceId.slice(0, 120)}, ${typeof body.sourceName === "string" && body.sourceName.trim() ? body.sourceName.trim().slice(0, 200) : sourceId.slice(0, 120)},
            'external', '{}'::jsonb, 'T2', 'isolated', 1440, true, 'ok', ${["ingest:auto-created"]})
    ON CONFLICT (id) DO UPDATE SET last_ok_at = now()
    RETURNING id, participation_mode, enabled`;
  // A switched-off source takes nothing in: what it would push is neither stored nor processed.
  if (!source!.enabled) throw new IngestError(409, `source ${source!.id} is switched off`);

  const seen = new Set<string>();
  let created = 0;
  let withdrawn = 0;
  const ledger = emptyLedgerCounts();
  for (const it of items) {
    const title = typeof it.title === "string" ? it.title.trim() : "";
    const rawUrl = typeof it.url === "string" ? it.url.trim() : "";
    let url: string | null = null;
    try {
      url = rawUrl ? normalizeUrl(rawUrl) : null;
    } catch {
      url = null;
    }
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);
    // Removed at the source: a record on the stored observation, never a delete (an unknown item is ignored).
    if (it.withdrawn === true && url) {
      const [known] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE identity_key = ${identityKeyFor({ sourceId: source!.id, url, title, via: "ingest" })} AND source_id = ${source!.id}`;
      const reason = typeof it.withdrawnReason === "string" && it.withdrawnReason.trim() ? it.withdrawnReason.trim().slice(0, 500) : "reported removed at the source";
      if (known && (await recordWithdrawal(known.id, { action: "withdraw", basis: "source-removed", reason, evidenceUrl: url, recordedBy: `ingest:${source!.id}` })).recorded) {
        withdrawn += 1;
        await publishArticle(known.id);
      }
      continue;
    }
    const published = typeof it.publishedAt === "string" ? new Date(it.publishedAt) : null;
    const flags = it.raw?._topka ?? {};
    // A report without a usable URL is a typed failure in the ledger (missing-provenance), not a silent skip.
    const res = await recordMaterial({
      sourceId: source!.id,
      url: url ?? rawUrl,
      title,
      author: typeof it.author === "string" ? it.author.slice(0, 200) : null,
      publishedAt: published && Number.isFinite(published.getTime()) ? published : null,
      raw: it.raw ?? null,
      via: "ingest",
      backfill: flags.backfill ? "reported-backfill" : flags.baseline ? "reported-baseline" : null,
    });
    countOutcome(ledger, res);
    if (res.created) created += 1;
    if (res.created || res.revised) await queueProcessing(res.articleId!);
  }
  await sql`UPDATE sources SET last_fetch_at = now(), last_ok_at = now() WHERE id = ${source!.id}`;
  await sql`INSERT INTO ingest_events (client, kind, status, summary) VALUES ('ingest-items', 'items', 'ok', ${sql.json({ sourceId: source!.id, received: items.length, created, ledger, withdrawn })})`;
  return { ok: true, created, ledger, withdrawn };
}
