// Exports material for the quality evals (docs/quality.md) from a database, read-only: candidate
// cases to label for a gold set, or the runtime snapshot the coverage, freshness, time-saved and
// citation evals read. Nothing is written to the database; texts are cut to short excerpts.
//   node --env-file=.env scripts/eval-candidates.ts --kind relevance --labels labels.tsv --out eval/gold/gold-relevance.jsonl
//   node --env-file=.env scripts/eval-candidates.ts --kind grouping --labels labels.tsv --out eval/gold/gold-grouping.jsonl
//   node --env-file=.env scripts/eval-candidates.ts --kind independence --labels groups.json --out eval/gold/gold-independence.jsonl
//   node --env-file=.env scripts/eval-candidates.ts --kind abstention --labels labels.tsv --out eval/gold/gold-abstention.jsonl
//   node --env-file=.env scripts/eval-candidates.ts --kind runtime --days 14 --out eval/snapshots/runtime.json
// A labels file lists one case per line: "<id> <label>" (relevance: article id + select/reject/either,
// with an optional third column "project:<project id>"; grouping: "<decision id>:<fact id> same|related|distinct";
// abstention: "<article id> sufficient|insufficient [reason|-] [blind]", or "construct <article id>" for the five
// constructed insufficient variants of a real article).
// Without --labels every case is written with gold null, ready to be labelled by hand.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { fingerprint, isAggregator, siteOf } from "@topka/backend/events/independence";
import { assessEvidence, type EvidenceInput } from "@topka/backend/projects/evidence";
import { checkCitations } from "@topka/backend/quality/citation";

const { values } = parseArgs({
  options: {
    kind: { type: "string" },
    labels: { type: "string" },
    out: { type: "string" },
    days: { type: "string", default: "14" },
    until: { type: "string" },
  },
});
const kind = values.kind;
if (!kind || !values.out) throw new Error("usage: --kind relevance|grouping|independence|runtime --out <file> [--labels <file>]");
// Every transaction of this connection is read-only: the export cannot write by mistake.
const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { default_transaction_read_only: "on" } as never, types: { numeric: { to: 1700, from: [1700], serialize: String, parse: Number }, int8: { to: 20, from: [20], serialize: String, parse: Number } } });

const clip = (s: string | null | undefined, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
const splitOf = (id: string) => (parseInt(id.replace(/[^0-9a-f]/gi, "").slice(-4) || "0", 16) % 10 < 7 ? "development" : "holdout");
const labelLines = () =>
  values.labels ? readFileSync(values.labels, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/)) : null;

function write(rows: unknown[] | Record<string, unknown>) {
  mkdirSync(path.dirname(values.out!), { recursive: true });
  const text = Array.isArray(rows) ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : JSON.stringify(rows) + "\n";
  writeFileSync(values.out!, text);
  console.log(`wrote ${Array.isArray(rows) ? rows.length + " cases" : "snapshot"} → ${values.out}`);
}

async function relevance() {
  const labels = labelLines() ?? [];
  const out: unknown[] = [];
  for (const [articleId, decision, projectRef] of labels) {
    const projectId = projectRef?.startsWith("project:") ? projectRef.slice(8) : null;
    const [a] = await db<any[]>`
      SELECT a.id, a.title, a.url, a.published_at, a.language, coalesce(nullif(a.body_text, ''), a.excerpt, '') AS body, a.x_post,
             s.name AS source_name, s.kind, s.tier, s.first_party,
             an.relevance, an.in_scope, an.category, an.title_zh, an.output, an.model, an.prompt_version
      FROM articles a JOIN sources s ON s.id = a.source_id
      LEFT JOIN LATERAL (SELECT * FROM analyses x WHERE x.article_id = a.id ORDER BY x.input_revision DESC, x.id DESC LIMIT 1) an ON true
      WHERE a.id = ${articleId!}`;
    if (!a) continue;
    const prefilter = a.output?.prefilter ?? null;
    const site = { scores: (a.output?.scores ?? []) as number[], threshold: a.output?.threshold ?? null, model: a.output?.scoreModel ?? a.model };
    let project: { scores: number[]; model: string; promptVersion: string } | null = null;
    if (projectId) {
      const [ps] = await db<any[]>`SELECT scores, model, prompt_version FROM project_scores WHERE project_id = ${projectId} AND article_id = ${articleId!}`;
      if (ps) project = { scores: ps.scores, model: ps.model, promptVersion: ps.prompt_version };
    }
    const body = String(a.body || a.x_post?.text || "");
    out.push({
      caseId: `rel-${projectId ? "p" : "s"}-${articleId}`,
      purpose: projectId ? "project" : "site",
      ...(projectId ? { project: "embodied" } : {}),
      material: { title: a.title_zh || a.title, originalTitle: a.title, publishedAt: a.published_at, sourceName: a.source_name, bodyZh: null, bodyOriginal: clip(body, 300), url: a.url },
      sourceFacts: { sourceKind: a.kind, sourceTier: a.tier, firstParty: a.first_party, language: a.language ?? null },
      samplingContext: { benchmarkSplit: splitOf(articleId!), samplingStratum: a.category ?? "uncategorised" },
      gold: { decision },
      recorded: {
        relevance: a.relevance, inScope: a.in_scope ?? true, prefilter: prefilter ? { label: prefilter.label ?? null, inScope: prefilter.inScope ?? null } : null,
        siteScores: site.scores, siteModel: site.model, projectScores: project?.scores ?? null, projectModel: project?.model ?? null,
      },
      origin: "production",
    });
  }
  write(out);
}

async function grouping() {
  const labels = labelLines() ?? [];
  const byDecision = new Map<number, Array<{ factId: number; gold: string }>>();
  for (const [key, gold] of labels) {
    const [d, f] = key!.split(":").map(Number);
    if (gold === "skip") continue;
    if (!byDecision.has(d!)) byDecision.set(d!, []);
    byDecision.get(d!)!.push({ factId: f!, gold: gold! });
  }
  const out: unknown[] = [];
  for (const [decisionId, pairs] of byDecision) {
    const [d] = await db<any[]>`
      SELECT gd.id, gd.article_id, gd.verdict, gd.fact_id, gd.story_id, gd.candidates, gd.created_at, a.title, a.published_at, a.discovered_at, s.name AS source,
             (SELECT title_zh FROM analyses x WHERE x.article_id = a.id ORDER BY x.id DESC LIMIT 1) AS title_zh
      FROM grouping_decisions gd JOIN articles a ON a.id = gd.article_id JOIN sources s ON s.id = a.source_id WHERE gd.id = ${decisionId}`;
    if (!d) continue;
    const cands: any[] = [];
    for (const c of d.candidates as any[]) {
      const [f] = await db<any[]>`
        SELECT f.id, f.title, f.story_id,
               -- The story's root as it stood when the decision was made (later reports cannot have started it).
               (SELECT y.id FROM facts y JOIN fact_articles z ON z.fact_id = y.id AND z.role IN ('primary', 'report')
                JOIN publications q ON q.article_id = z.article_id WHERE y.story_id = f.story_id
                  AND NOT EXISTS (SELECT 1 FROM grouping_decisions g2 WHERE g2.article_id = z.article_id AND g2.created_at >= ${d.created_at})
                  AND EXISTS (SELECT 1 FROM grouping_decisions g3 WHERE g3.article_id = z.article_id AND g3.created_at < ${d.created_at})
                ORDER BY coalesce(q.published_at, q.discovered_at), y.id LIMIT 1) AS root
        FROM facts f WHERE f.id = ${c.id}`;
      cands.push({ factId: c.id, storyId: f?.story_id ?? null, storyRoot: f ? Number(f.root) === Number(f.id) : false, title: f?.title ?? null, score: c.score, relation: c.relation ?? null, confidence: c.confidence ?? null });
    }
    const reviews: Record<string, string> = {};
    for (const r of await db<any[]>`SELECT subject, response FROM receipts WHERE purpose = 'group_review' AND subject LIKE ${`article:${d.article_id}:fact:%`} ORDER BY id`) {
      const fact = String(r.subject).split(":fact:")[1];
      let rel: string | null = null;
      try {
        const content = r.response?.choices?.[0]?.message?.content;
        rel = JSON.parse(typeof content === "string" ? content.replace(/^```(json)?|```$/g, "") : "{}").relation ?? null;
      } catch {}
      if (fact && rel) reviews[fact] = rel;
    }
    const recordedFactStory = d.fact_id ? (await db<any[]>`SELECT story_id FROM facts WHERE id = ${d.fact_id}`)[0]?.story_id ?? d.story_id : d.story_id;
    out.push({
      caseId: `grp-${decisionId}`,
      article: { title: d.title_zh || d.title, at: d.published_at ?? d.discovered_at, source: d.source },
      candidates: cands,
      reviews,
      recorded: { verdict: d.verdict, factId: d.fact_id, storyId: recordedFactStory },
      pairs,
      samplingContext: { benchmarkSplit: splitOf(String(decisionId).padStart(4, "0")) },
      origin: "production",
    });
  }
  write(out);
}

/** Per source: whether it is a link aggregator, from its last 200 URLs. */
async function aggregatorFlags(sourceIds: string[]) {
  const flags = new Map<string, boolean>();
  for (const id of new Set(sourceIds)) {
    const urls = (await db<{ url: string }[]>`SELECT url FROM articles WHERE source_id = ${id} ORDER BY discovered_at DESC LIMIT 200`).map((r) => r.url);
    flags.set(id, isAggregator(urls));
  }
  return flags;
}

async function independence() {
  // groups.json: [{ "groupId": "...", "origin": "story|same-title|discovery", "articles": [{ "id": "...", "upstream": "<label>" }] }]
  const groups = JSON.parse(readFileSync(values.labels!, "utf8")) as Array<{ groupId: string; origin: string; note?: string; articles: Array<{ id: string; upstream: string; sourceId?: string }> }>;
  const out: unknown[] = [];
  for (const g of groups) {
    const items: any[] = [];
    for (const m of g.articles) {
      const [a] = await db<any[]>`
        SELECT a.id, a.title, a.url, a.published_at, a.discovered_at, coalesce(nullif(a.body_text, ''), a.excerpt, '') AS body, a.source_id, s.name AS source_name
        FROM articles a JOIN sources s ON s.id = coalesce(${m.sourceId ?? null}::text, a.source_id) WHERE a.id = ${m.id}`;
      if (!a) throw new Error(`article ${m.id} missing`);
      const sourceId = m.sourceId ?? a.source_id;
      const body = String(a.body);
      const tail = body.slice(-400);
      items.push({
        id: `${a.id}${m.sourceId ? "@" + m.sourceId : ""}`, sourceId, sourceName: m.sourceId ? (await db<any[]>`SELECT name FROM sources WHERE id = ${m.sourceId}`)[0]!.name : a.source_name,
        url: a.url, title: a.title, publishedAt: a.published_at ?? a.discovered_at,
        lead: clip(body, 320), tail: [...tail.matchAll(/https?:\/\/[^\s<>"'）)】]+/g)].map((x) => x[0]).join(" "),
        bodyChars: body.length, signature: fingerprint(body), upstream: m.upstream,
      });
    }
    const flags = await aggregatorFlags(items.map((i) => i.sourceId));
    out.push({
      caseId: `ind-${g.groupId}`, origin: g.origin, note: g.note ?? null,
      items: items.map((i) => ({ ...i, aggregator: flags.get(i.sourceId) ?? false })),
      gold: { upstreams: new Set(items.map((i) => i.upstream)).size },
      source: "production",
    });
  }
  // Production has no signal group yet (sources.signal_group_id): six constructed cases declare two of a
  // real story's own-reporting sources one group, whose own reports then count once.
  const derived: unknown[] = [];
  for (const c of out as Array<{ caseId: string; items: Array<{ sourceId: string; sourceName: string; upstream: string }> }>) {
    if (derived.length === 6 || !c.caseId.startsWith("ind-story")) continue;
    const own = [...new Map(c.items.filter((i) => i.upstream === i.sourceName).map((i) => [i.sourceId, i.sourceName])).entries()];
    if (own.length < 3) continue;
    const [[a, an], [b, bn]] = own as [[string, string], [string, string]];
    const group = `sg-${c.caseId}`;
    const items = c.items.map((i) => (i.sourceId === a || i.sourceId === b
      ? { ...i, signalGroupId: group, upstream: i.upstream === i.sourceName ? `group:${group}` : i.upstream }
      : i));
    derived.push({
      ...c, caseId: `ind-signalgroup-${c.caseId.slice(4)}`, origin: "constructed", items,
      gold: { upstreams: new Set(items.map((i) => i.upstream)).size },
      constructed: `${an} and ${bn} declared one signal group (sources.signal_group_id); their own reports count once`,
    });
  }
  write([...out, ...derived]);
}

async function runtime() {
  const until = values.until ? new Date(values.until) : new Date();
  const since = new Date(until.getTime() - Number(values.days) * 86_400_000);
  const sources = await db<any[]>`
    SELECT s.id, s.kind, s.enabled, s.health, s.interval_minutes AS interval,
           EXISTS (SELECT 1 FROM project_sources ps JOIN tracking_projects p ON p.id = ps.project_id WHERE ps.source_id = s.id AND NOT ps.paused AND p.status = 'active') AS required
    FROM sources s ORDER BY s.id`;
  const index = new Map(sources.map((s, i) => [s.id as string, i]));
  const runs = await db<any[]>`SELECT source_id, started_at, finished_at, status FROM fetch_runs WHERE started_at >= ${since} AND started_at < ${until} ORDER BY started_at`;
  const articles = await db<any[]>`
    -- Papers and code releases are dated differently from news (an arXiv listing day, a tag time): kept apart.
    SELECT CASE WHEN s.name ~* 'arxiv|papers' THEN 'paper' WHEN s.kind ~ 'github' OR s.name ~* 'releases|commits' THEN 'release' WHEN s.kind = 'rss' THEN 'news' ELSE s.kind END AS kind,
           a.published_at, a.discovered_at, a.backfill FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.discovered_at >= ${since} AND a.discovered_at < ${until}`;
  const users = await db<any[]>`SELECT DISTINCT user_id FROM user_issues ORDER BY user_id`;
  const uid = new Map(users.map((u, i) => [u.user_id as string, `u${i + 1}`]));
  const issues = await db<any[]>`SELECT user_id, to_char(issue_date, 'YYYY-MM-DD') AS date, issue_no, cutoff, window_since, fixed_at FROM user_issues WHERE fixed_at < ${until} ORDER BY issue_date`;
  const items = await db<any[]>`SELECT user_id, to_char(issue_date, 'YYYY-MM-DD') AS date, position, article_id FROM user_issue_items`;
  const reads = await db<any[]>`SELECT user_id, article_id, opened_at FROM user_issue_reads WHERE opened_at < ${until}`;
  const marks = await db<any[]>`SELECT user_id, article_id, mark, at FROM user_item_marks WHERE at < ${until}`;
  // Materials a reader's sources brought in each issue window (the "素材" of 更新/素材比).
  const materials: Array<{ user: string; date: string; n: number }> = [];
  for (const i of issues) {
    const [m] = await db<any[]>`
      SELECT count(DISTINCT a.id)::int AS n FROM articles a
      WHERE a.discovered_at > ${i.window_since} AND a.discovered_at <= ${i.cutoff}
        AND a.source_id IN (SELECT ps.source_id FROM project_sources ps JOIN tracking_projects p ON p.id = ps.project_id WHERE p.owner_id = ${i.user_id} AND NOT ps.paused)`;
    materials.push({ user: uid.get(i.user_id)!, date: i.date, n: m!.n });
  }
  const articleKey = new Map<string, string>();
  const ak = (id: string) => {
    if (!articleKey.has(id)) articleKey.set(id, `a${articleKey.size + 1}`);
    return articleKey.get(id)!;
  };
  const t = (d: Date | null) => (d ? Math.round(new Date(d).getTime() / 1000) : null);
  write({
    createdAt: new Date().toISOString(), since: since.toISOString(), until: until.toISOString(), origin: "production",
    sources: sources.map((s) => ({ kind: s.kind, enabled: s.enabled, health: s.health, interval: s.interval, required: s.required })),
    runs: runs.map((r) => [index.get(r.source_id) ?? -1, t(r.started_at), r.status === "ok" ? 1 : r.status === "failed" ? 0 : -1]),
    articles: articles.map((a) => [a.kind, t(a.published_at), t(a.discovered_at), a.backfill ? 1 : 0]),
    issues: issues.map((i) => ({ user: uid.get(i.user_id), date: i.date, no: i.issue_no, fixedAt: t(i.fixed_at) })),
    items: items.filter((i) => uid.has(i.user_id)).map((i) => ({ user: uid.get(i.user_id), date: i.date, position: i.position, article: ak(i.article_id) })),
    reads: reads.filter((r) => uid.has(r.user_id)).map((r) => ({ user: uid.get(r.user_id), article: ak(r.article_id), at: t(r.opened_at) })),
    marks: marks.filter((m) => uid.has(m.user_id)).map((m) => ({ user: uid.get(m.user_id), article: ak(m.article_id), mark: m.mark, at: t(m.at) })),
    materials,
    // The chain check over every card shown so far (ids dropped: the counts are what the eval reads).
    citation: await checkCitations({ db: db as never }).then(({ broken, ...rest }) => ({ ...rest, broken: broken.map((b) => ({ kind: b.kind, problems: b.problems })) })),
  });
}

async function evidenceInputs(ids: string[]): Promise<Map<string, { source: string; kind: string; input: EvidenceInput }>> {
  const rows = await db<{ id: string; url: string | null; title: string; body: string; excerpt: string; post: string; first_party: boolean; source: string; kind: string; upstreams: number; others: string[] }[]>`
    SELECT a.id, a.url, a.title, coalesce(a.body_text, '') AS body, coalesce(a.excerpt, '') AS excerpt, coalesce(a.x_post->>'text', '') AS post,
           s.first_party, s.name AS source, s.kind,
           greatest(1, (SELECT count(DISTINCT g.participant_key) FROM story_signals g WHERE g.story_id = own.story_id))::int AS upstreams,
           coalesce((SELECT array_agg(o.title) FROM story_signals g JOIN articles o ON o.id = g.article_id
                     WHERE g.story_id = own.story_id AND g.participant_key IS DISTINCT FROM own.participant_key), '{}') AS others
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN LATERAL (SELECT story_id, participant_key FROM story_signals WHERE article_id = a.id ORDER BY observed_at DESC LIMIT 1) own ON true
    WHERE a.id = ANY(${ids})`;
  return new Map(rows.map((r) => [r.id, {
    source: r.source, kind: r.kind,
    input: {
      url: r.url, title: r.title, body: clip(r.body, 600), excerpt: clip(r.excerpt, 600), postText: clip(r.post, 600),
      firstParty: r.first_party, upstreams: r.upstreams, otherReports: r.others.slice(0, 12).map((t) => clip(t, 120)),
    },
  }]));
}

/**
 * Real items (the issue's own candidates and items the rules turn down, labelled by hand) and, for a few
 * real articles, five constructed variants that each lack one kind of evidence.
 */
async function abstention() {
  const lines = labelLines();
  if (!lines) {
    // Unlabelled: the pool to label — every shown issue item, every eligible item the rules turn down, and a sample of other issue candidates.
    const ids = (await db<{ id: string }[]>`
      SELECT DISTINCT article_id AS id FROM user_issue_items
      UNION SELECT p.article_id FROM publications p WHERE p.eligible AND p.listed_at > now() - ${`${values.days} days`}::interval
      UNION (SELECT p.article_id FROM publications p JOIN project_scores sc ON sc.article_id = p.article_id
             WHERE p.in_scope AND p.eligible AND sc.score >= 50 ORDER BY md5(p.article_id) LIMIT 60)`).map((r) => r.id);
    const inputs = await evidenceInputs(ids);
    const shown = new Set((await db<{ id: string }[]>`SELECT article_id AS id FROM user_issue_items`).map((r) => r.id));
    const rows = [...inputs].map(([id, x]) => ({ id, shown: shown.has(id), rule: assessEvidence(x.input), source: x.source, title: x.input.title }))
      .filter((r) => r.shown || !r.rule.sufficient || r.id.charCodeAt(0) % 3 === 0);
    return write(rows);
  }
  const real = lines.filter((l) => l[0] !== "construct");
  const bases = lines.filter((l) => l[0] === "construct").map((l) => l[1]!);
  const inputs = await evidenceInputs([...real.map((l) => l[0]!), ...bases]);
  const cases: unknown[] = [];
  for (const [id, label, reason, blind] of real) {
    const x = inputs.get(id!);
    if (!x) throw new Error(`no article ${id}`);
    cases.push({ caseId: `abs-${id}`, origin: "production", split: blind === "blind" ? "blind" : splitOf(id!), article: { id, source: x.source, kind: x.kind }, input: x.input, gold: { sufficient: label === "sufficient", ...(reason && reason !== "-" ? { reason } : {}) } });
  }
  for (const id of bases) {
    const x = inputs.get(id)!;
    const zh = /[\u4e00-\u9fff]/.test(x.input.title);
    const text = x.input.body || x.input.excerpt;
    const variants: Record<string, Partial<EvidenceInput>> = {
      "no-source": { url: null },
      "title-only": { body: "", excerpt: "", postText: "" },
      thin: { body: zh ? text.slice(0, 25) : text.split(/\s+/).slice(0, 18).join(" "), excerpt: "", postText: "" },
      "unsourced-claim": {
        title: zh ? `知情人士：${x.input.title}` : `${x.input.title}, people familiar with the matter say`,
        body: (zh ? "据知情人士透露，" : "According to people familiar with the matter, ") + x.input.body,
        firstParty: false, upstreams: 1, otherReports: [],
      },
      "source-conflict": { otherReports: [...x.input.otherReports, zh ? `相关方否认：${x.input.title.slice(0, 40)}` : `Company denies report: ${x.input.title.slice(0, 60)}`] },
    };
    for (const [variant, patch] of Object.entries(variants)) {
      cases.push({ caseId: `abs-${variant}-${id}`, origin: "constructed", split: splitOf(id), constructedFrom: id, variant, article: { id, source: x.source, kind: x.kind }, input: { ...x.input, ...patch }, gold: { sufficient: false, reason: variant } });
    }
  }
  write(cases);
}

try {
  if (kind === "relevance") await relevance();
  else if (kind === "abstention") await abstention();
  else if (kind === "grouping") await grouping();
  else if (kind === "independence") await independence();
  else if (kind === "runtime") await runtime();
  else throw new Error(`unknown kind ${kind}`);
} finally {
  await db.end();
}
