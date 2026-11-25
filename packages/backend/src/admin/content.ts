// Content diagnostics and corrections (F19). Find any item by id, URL or title and see its whole
// chain: source → discoveries → revisions → model receipts → decisions → publication → grouping.
// Visibility changes and manual corrections go through editorial overrides with a version check, are
// re-projected into the publication row the projects read, and are audited.
import { z } from "zod";
import { ARTICLE_ID_PATTERN, CATEGORY_KEYS } from "@topka/contracts/taxonomy";
import { sql } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { normalizeUrl } from "../lib/url.ts";
import { publishArticle } from "../publication/publish.ts";
import { mergeStoryInto } from "../events/merge.ts";
import { audit } from "./auth.ts";
import { Conflict, Invalid } from "./sources.ts";
import { ledgerStates, recordWithdrawal, WITHDRAWAL_BASES, WithdrawalInvalid } from "../content/withdrawals.ts";

/** One row of the content finder: enough to recognise an item and open it. */
export interface ContentRow {
  id: string;
  title: string | null;
  url: string;
  source: string;
  discovered_at: Date;
  processing_state: string;
  visibility: string | null;
  selected: boolean | null;
  score: number | null;
}

/**
 * The admin's finder. An empty term lists the newest items: a fresh install has to be able to see what
 * arrived without already knowing a title or id (the 内容诊断 page opens to that list).
 */
export async function searchContent(q: string): Promise<ContentRow[]> {
  const term = q.trim();
  if (!term) {
    return sql<ContentRow[]>`
      SELECT a.id, coalesce(p.title, a.title) AS title, a.url, s.name AS source, a.discovered_at, a.processing_state,
             p.visibility, p.selected, p.score
      FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
      ORDER BY a.discovered_at DESC LIMIT 50`;
  }
  const byId = ARTICLE_ID_PATTERN.test(term) ? term : null;
  const url = /^https?:\/\//i.test(term) ? normalizeUrl(term) : null;
  return sql<ContentRow[]>`
    SELECT a.id, coalesce(p.title, a.title) AS title, a.url, s.name AS source, a.discovered_at, a.processing_state,
           p.visibility, p.selected, p.score
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
    WHERE (${byId}::text IS NOT NULL AND a.id = ${byId})
       OR (${url}::text IS NOT NULL AND (a.url = ${url} OR a.identity_key = ${url} OR a.url = ${term}))
       OR (${url}::text IS NULL AND (a.title ILIKE ${`%${term}%`} OR p.title ILIKE ${`%${term}%`}))
    ORDER BY a.discovered_at DESC LIMIT 50`;
}

export async function contentChain(id: string) {
  const [article] = await sql`
    SELECT a.id, a.source_id, a.url, a.identity_key, a.title, a.author, a.language, a.published_at, a.published_at_claim, a.discovered_at,
           a.timeline_at, a.backfill, a.body_status, a.revision, a.processing_state, a.processing_error, a.grouped_at, length(a.body_text) AS body_chars,
           s.name AS source_name, s.kind AS source_kind, s.tier, s.participation_mode, s.site_fulltext
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${id}`;
  if (!article) return null;
  const [discoveries, revisions, analyses, publication, override, membership, decisions, history] = await Promise.all([
    sql`SELECT source_id, via, discovered_at FROM article_discoveries WHERE article_id = ${id} ORDER BY discovered_at`,
    sql`SELECT revision, title, content_hash, created_at FROM article_revisions WHERE article_id = ${id} ORDER BY revision DESC LIMIT 10`,
    sql`
      SELECT an.id, an.origin, an.model, an.prompt_version, an.input_revision, an.relevance, an.category, an.score, an.selected, an.title_zh, an.reason_zh,
             an.created_at,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'service', r.service, 'model', r.model, 'cost', r.cost, 'at', r.created_at) ORDER BY r.id), '[]'::jsonb)
                FROM receipts r WHERE r.id = ANY(an.receipt_ids)) AS receipts
      FROM analyses an WHERE an.article_id = ${id} ORDER BY an.created_at DESC LIMIT 10`,
    sql`SELECT * FROM publications WHERE article_id = ${id}`,
    sql`SELECT fields, visibility, reason, version, updated_by, updated_at FROM editorial_overrides WHERE article_id = ${id}`,
    sql`
      SELECT fa.fact_id, fa.role, fa.manual, f.public_id AS fact_public_id, f.title AS fact_title, st.id AS story_id, st.public_id AS story_public_id, st.title AS story_title
      FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id LEFT JOIN stories st ON st.id = f.story_id WHERE fa.article_id = ${id}`,
    sql`SELECT verdict, fact_id, story_id, receipt_id, candidates, created_at FROM grouping_decisions WHERE article_id = ${id} ORDER BY created_at DESC LIMIT 5`,
    sql`SELECT created_at, actor, action, reason, before, after FROM audit_log WHERE subject = ${`content:${id}`} ORDER BY created_at DESC LIMIT 20`,
  ]);
  // The observation ledger: its presentation state, every withdrawal record and refused conflicting report.
  const [observation, withdrawals, rejections] = await Promise.all([
    ledgerStates([id]).then((m) => m.get(id) ?? null),
    sql`SELECT action, basis, reason, evidence_url, recorded_by, recorded_at FROM article_withdrawals WHERE article_id = ${id} ORDER BY id DESC`,
    sql`SELECT state, code, title, excerpt, version_marker, stored_revision, stored_marker, via, detail, reported_at FROM observation_rejections WHERE article_id = ${id} ORDER BY id DESC LIMIT 20`,
  ]);
  return { article, discoveries, revisions, analyses, publication: publication[0] ?? null, override: override[0] ?? null, membership, decisions, history, observation, withdrawals, rejections };
}


const STALE = "这条内容的人工设置已被修改，请刷新后再操作";

async function overrideRow(id: string) {
  const [o] = await sql<{ fields: Record<string, unknown>; visibility: string | null; version: number }[]>`SELECT fields, visibility, version FROM editorial_overrides WHERE article_id = ${id}`;
  return o ?? { fields: {}, visibility: null, version: 0 };
}

/**
 * Public / summary-only / withdrawn, through the one publication projection the projects read.
 */
export async function setVisibility(id: string, input: { visibility: "public" | "summary-only" | "withdrawn"; reason: string; version: number }, actor: string) {
  if (!input.reason?.trim()) throw new Invalid("reason is required");
  const before = await overrideRow(id);
  if (before.version !== input.version) throw new Conflict(STALE);
  // The version check and the write are one statement: of two tabs saving the same version, one wins.
  const written = await sql`
    INSERT INTO editorial_overrides (article_id, visibility, reason, version, updated_by) VALUES (${id}, ${input.visibility}, ${input.reason}, 1, ${actor})
    ON CONFLICT (article_id) DO UPDATE SET visibility = EXCLUDED.visibility, reason = EXCLUDED.reason, version = editorial_overrides.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
    WHERE editorial_overrides.version = ${input.version}
    RETURNING version`;
  if (!written.count) throw new Conflict(STALE);
  const published = await publishArticle(id);
  await audit(actor, "content.visibility", `content:${id}`, input.reason, { visibility: before.visibility }, { visibility: input.visibility });
  return published;
}

/**
 * Records that the source withdrew the material (or that it is current again): an appended ledger
 * record, never an edit. The publication follows (out of the pool while withdrawn); audited.
 */
export async function recordContentWithdrawal(id: string, input: { action?: unknown; basis?: unknown; reason?: unknown; evidenceUrl?: unknown }, actor: string) {
  const action = input.action === "reinstate" ? "reinstate" : input.action === "withdraw" ? "withdraw" : null;
  if (!action) throw new Invalid("action must be withdraw or reinstate");
  const basis = WITHDRAWAL_BASES.find((b) => b === input.basis);
  if (!basis) throw new Invalid(`basis must be one of ${WITHDRAWAL_BASES.join(", ")}`);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new Invalid("reason is required");
  const [exists] = await sql`SELECT 1 FROM articles WHERE id = ${id}`;
  if (!exists) return null;
  let out;
  try {
    out = await recordWithdrawal(id, { action, basis, reason, evidenceUrl: typeof input.evidenceUrl === "string" ? input.evidenceUrl : null, recordedBy: actor });
  } catch (error) {
    if (error instanceof WithdrawalInvalid) throw new Invalid(error.message);
    throw error;
  }
  if (!out.recorded) throw new Conflict(action === "withdraw" ? "already withdrawn" : "not withdrawn");
  const published = await publishArticle(id);
  await audit(actor, `content.${action}`, `content:${id}`, reason, null, { basis, withdrawn: out.withdrawn });
  return { withdrawn: out.withdrawn, observation: (await ledgerStates([id])).get(id) ?? null };
}

const FieldsSchema = z
  .object({
    title: z.string().min(1).max(300),
    summary: z.string().max(2000),
    reason: z.string().max(1000),
    category: z.enum(CATEGORY_KEYS as unknown as [string, ...string[]]),
    tags: z.array(z.string().max(60)).max(20),
    selected: z.boolean(),
    silent: z.boolean(),
  })
  .partial()
  .strict();

/** Manual corrections win over model output; null clears a correction. */
export async function overrideFields(id: string, input: { fields: unknown; clear?: string[]; reason: string; version: number }, actor: string) {
  if (!input.reason?.trim()) throw new Invalid("reason is required");
  const fields = FieldsSchema.parse(input.fields ?? {});
  const before = await overrideRow(id);
  if (before.version !== input.version) throw new Conflict(STALE);
  const next = { ...before.fields, ...fields };
  for (const k of input.clear ?? []) delete (next as Record<string, unknown>)[k];
  const written = await sql`
    INSERT INTO editorial_overrides (article_id, fields, reason, version, updated_by) VALUES (${id}, ${sql.json(next as never)}, ${input.reason}, 1, ${actor})
    ON CONFLICT (article_id) DO UPDATE SET fields = EXCLUDED.fields, reason = EXCLUDED.reason, version = editorial_overrides.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
    WHERE editorial_overrides.version = ${input.version}
    RETURNING version`;
  if (!written.count) throw new Conflict(STALE);
  const published = await publishArticle(id);
  await audit(actor, "content.override", `content:${id}`, input.reason, before.fields, next);
  return published;
}

/**
 * Re-runs a pipeline step for the current revision. Re-evaluation is a new paid model call bound to
 * the request id, so submitting the same request twice neither enqueues nor pays twice.
 */
export async function rerun(id: string, step: "extract" | "analyze" | "group", requestId: string, actor: string) {
  if (!/^[\w-]{8,80}$/.test(requestId)) throw new Invalid("a stable request id is required");
  const [a] = await sql`SELECT id FROM articles WHERE id = ${id}`;
  if (!a) return null;
  let jobId: string | null;
  if (step === "group") {
    // An explicit regroup replaces an earlier manual "keep standalone" decision and the automatic membership.
    await sql`DELETE FROM grouping_overrides WHERE article_id = ${id}`;
    jobId = await enqueue(QUEUES.group, { articleId: id, force: true }, { singletonKey: `manual:group:${id}:${requestId}` });
  } else {
    await sql`UPDATE articles SET processing_state = 'new', processing_error = NULL, processing_attempts = 0, processing_retry_at = NULL,
                body_status = CASE WHEN ${step === "extract"} THEN 'pending' ELSE body_status END WHERE id = ${id}`;
    jobId = step === "analyze"
      ? await queueProcessing(id, { step: "analyze", attemptTag: `admin:${requestId}` })
      : await queueProcessing(id, { step: "extract" });
  }
  await audit(actor, `content.rerun.${step}`, `content:${id}`, null, null, { jobId, requestId }, requestId);
  return { jobId };
}

/**
 * Takes an article out of its fact; it is shown on its own again and stays that way (automatic
 * grouping, retries and later revisions do not re-attach it; an explicit regroup does). Its
 * discussion evidence leaves the old story.
 */
export async function detachFromFact(id: string, reason: string, actor: string) {
  if (!reason.trim()) throw new Invalid("reason is required");
  const { facts, stories } = await sql.begin(async (tx) => {
    // The grouping job writes under the same lock and reads this decision again before it does.
    const [found] = await tx`SELECT 1 FROM articles WHERE id = ${id} FOR UPDATE`;
    if (!found) throw new Invalid("article not found");
    const removed = await tx<{ fact_id: number }[]>`DELETE FROM fact_articles WHERE article_id = ${id} RETURNING fact_id`;
    const factIds = removed.map((r) => r.fact_id);
    const storyRows = factIds.length ? await tx<{ story_id: number }[]>`SELECT DISTINCT story_id FROM facts WHERE id = ANY(${factIds}) AND story_id IS NOT NULL` : [];
    const storyIds = storyRows.map((r) => r.story_id);
    if (storyIds.length) await tx`DELETE FROM story_signals WHERE article_id = ${id} AND story_id = ANY(${storyIds})`;
    await tx`INSERT INTO grouping_overrides (article_id, reason, actor) VALUES (${id}, ${reason}, ${actor})
             ON CONFLICT (article_id) DO UPDATE SET reason = EXCLUDED.reason, actor = EXCLUDED.actor, created_at = now()`;
    await tx`UPDATE articles SET grouped_at = now() WHERE id = ${id}`;
    return { facts: factIds, stories: storyIds };
  });
  await publishArticle(id);
  // The fact's other reports may take a new reading-group anchor.
  if (facts.length) {
    const others = await sql<{ article_id: string }[]>`SELECT DISTINCT article_id FROM fact_articles WHERE fact_id = ANY(${facts})`;
    for (const o of others) await publishArticle(o.article_id);
  }
  await audit(actor, "content.detach", `content:${id}`, reason, { facts, stories }, null);
  return { detached: facts.length };
}

/** Merges one story into another: facts move, the old public id keeps working as an alias. */
export async function mergeStories(fromId: number, intoId: number, reason: string, actor: string) {
  if (fromId === intoId) throw new Invalid("cannot merge a story into itself");
  const done = await mergeStoryInto(fromId, intoId, reason, actor);
  if (done) return done;
  const found = await sql<{ id: number }[]>`SELECT id FROM stories WHERE id IN (${fromId}, ${intoId})`;
  if (found.length < 2) throw new Invalid("story not found");
  throw new Conflict("两个事件都必须是未合并的事件");
}
