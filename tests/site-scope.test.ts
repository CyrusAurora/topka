// The site's scope (prompts/prefilter.md's industry rule, here AI and embodied AI): a followed source's
// prefilter passes what its projects follow (battery, earnings…) and says separately whether the item is
// in scope; an item passed only for a project is never selected, never enters the daily issue (每日 Top 3,
// web 今日, the reminder headline) or the public lists, yet stays in that project's own today view. The
// model leaving the field out: a source marked config.scope "mixed" counts out, an all-AI source in.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { analyzeArticle } from "@topka/backend/editorial/analyze";
import { publishArticle } from "@topka/backend/publication/publish";
import { listedCondition, selectedCondition } from "@topka/backend/publication/items";
import { createProject } from "@topka/backend/projects/create-project";
import { issueCandidates } from "@topka/backend/projects/issues";
import { buildToday } from "@topka/backend/projects/today";
import { requireProjectOwner } from "@topka/backend/publication/project-owner";
import { stopBoss } from "@topka/backend/jobs/queue";
import { itemFeed } from "@topka/backend/publication/feeds";
import { v1Items } from "@topka/backend/publication/v1";
import { sitemapXml } from "@topka/backend/publication/sitemap";
import { llmsTxt } from "@topka/backend/publication/llms";

const T = tag();
const MIXED = `test-scope-mixed-${T}`;
const AI = `test-scope-ai-${T}`;
const USER = `u-scope-${T}`;
const prefilterSystems: string[] = [];

const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = system.includes("宽召回的AI相关性预筛") ? "prefilter" : system.includes("项目相关性评分器") ? "project-score"
    : system.includes("事件注意力评分器") ? "score" : system.includes("内容理解编辑") ? "understand" : system.includes("资料结构化助手") ? "structure" : "summarize";
  const answer = (content: unknown) => ({ id: `stub-${Math.random()}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") {
    prefilterSystems.push(system);
    if (user.includes("NOFIELD")) return answer({ label: "PASS", reason: "测试" });
    return answer({ label: "PASS", inScope: user.includes("BATTERY") ? "false" : true, reason: "测试" });
  }
  if (step === "project-score") return answer({ projectScores: { P1: 92 } });
  if (step === "score") return answer({ attentionScore: 90 });
  if (step === "understand") return answer({ itemType: "industry_event", authorRole: "principal", tags: [], editorialJudgment: "理由", titleZh: "理解标题", summaryZh: "理解摘要。第二句。" });
  if (step === "structure") return answer({ category: "ai-models", tags: [], subjects: [], fact: null });
  return answer("title_zh: 翻译标题\nsummary_zh: 翻译摘要。第二句。");
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

let projectId: string;
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at) VALUES
    (${MIXED}, 'Mixed scope source', 'rss', 'T1', 'editorial', ${sql.json({ scope: "mixed" })}, '2100-01-01'),
    (${AI}, 'AI scope source', 'rss', 'T1', 'editorial', '{}', '2100-01-01')`;
  await sql`INSERT INTO users (id, email, password_hash) VALUES (${USER}, ${`scope-${T}@example.com`}, 'x')`;
  projectId = (await createProject({ ownerId: USER, target: `动力电池 ${T}`, purpose: "跟踪电池与新能源车", sources: [{ sourceId: MIXED, required: false }, { sourceId: AI, required: false }] })).project.id;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

const ids: Record<string, string> = {};
async function item(source: string, key: string, title: string) {
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.com/scope-${T}/${key}`, title: `${title} ${T}`,
    bodyText: `${`${title} with numbers and details from the company. `.repeat(6)} (${T} ${key})`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never);
  const res = await analyzeArticle(articleId);
  await publishArticle(articleId);
  ids[key] = articleId;
  return res;
}

test("in scope is judged by the same prefilter call; only in-scope items are selected", async () => {
  const battery = await item(MIXED, "battery", "BATTERY CATL solid-state cell output");
  const ai = await item(MIXED, "ai", "A lab releases an open VLA model for humanoid robots");
  const mixedSilent = await item(MIXED, "mixed-silent", "NOFIELD quarterly results of a car maker");
  const aiSilent = await item(AI, "ai-silent", "NOFIELD a new reasoning model");
  assert.ok(prefilterSystems.every((s) => s.includes("inScope")), "the project-aware prompt asks for inScope");
  assert.equal(battery!.output!.relevance, "pass", "the project keeps it");
  assert.equal(battery!.output!.inScope, false);
  assert.equal(battery!.output!.selected, false, "a high project score does not select an off-scope item");
  assert.equal(ai!.output!.inScope, true);
  assert.equal(ai!.output!.selected, true);
  assert.equal(mixedSilent!.output!.inScope, false, "field missing on a mixed source: out");
  assert.equal(aiSilent!.output!.inScope, true, "field missing on an all-AI source: in");

  const rows = await sql<{ article_id: string; a_scope: boolean; p_scope: boolean; eligible: boolean; selected: boolean; label: string; out: boolean | null }[]>`
    SELECT p.article_id, an.in_scope AS a_scope, p.in_scope AS p_scope, p.eligible, p.selected,
           an.output->'prefilter'->>'label' AS label, (an.output->'prefilter'->>'inScope')::boolean AS out
    FROM publications p JOIN analyses an ON an.id = p.analysis_id WHERE p.article_id = ${ids.battery!}`;
  assert.deepEqual(rows.map((r) => [r.a_scope, r.p_scope, r.eligible, r.selected, r.label, r.out]), [[false, false, true, false, "PASS", false]]);
});

test("the daily issue and the public lists leave it out; the project's own today view keeps it", async () => {
  const until = new Date(Date.now() + 3_600_000);
  const issue = (await issueCandidates(USER, new Date(Date.now() - 3_600_000), until, sql)).map((c) => c.article_id);
  assert.ok(issue.includes(ids.ai!) && issue.includes(ids["ai-silent"]!));
  assert.ok(!issue.includes(ids.battery!) && !issue.includes(ids["mixed-silent"]!), "never in Top 3");

  const access = await requireProjectOwner(USER, projectId);
  assert.ok(access.kind === "ok");
  const view = await buildToday(access.project, USER, { now: until, cards: 10, record: false });
  const shown = view.items.map((i) => i.id);
  assert.ok(shown.includes(ids.battery!) && shown.includes(ids.ai!), "the project still sees its battery news");

  const mine = Object.values(ids);
  const listed = await sql<{ article_id: string }[]>`SELECT p.article_id FROM publications p WHERE ${listedCondition(until)} AND p.article_id IN ${sql(mine)}`;
  assert.deepEqual(listed.map((r) => r.article_id).sort(), [ids.ai!, ids["ai-silent"]!].sort());
  const selected = await sql<{ article_id: string }[]>`SELECT p.article_id FROM publications p WHERE ${selectedCondition(until)} AND p.article_id IN ${sql(mine)}`;
  assert.ok(!selected.some((r) => r.article_id === ids.battery));
});

test("the machine interfaces (RSS, API v1, sitemap, llms.txt) carry only in-scope items", async () => {
  const out = [ids.battery!, ids["mixed-silent"]!];
  const until = new Date(Date.now() + 3_600_000); // past the selected items' release gate
  for (const kind of ["all", "selected", "selected-full"] as const) {
    const xml = await itemFeed(kind, null, until);
    for (const id of out) assert.ok(!xml.includes(id), `${kind} feed leaves out ${id}`);
    assert.ok(!xml.includes("/items/"), "feed links go to the original article, not a retired item page");
  }
  const all = await v1Items({ mode: "all", window: "7d", by: "timeline", category: null, q: null, limit: 100, cursor: null }, until);
  const got = all.items.map((i: { id: string }) => i.id);
  assert.ok(got.includes(ids.ai!), "an in-scope item is listed");
  for (const id of out) assert.ok(!got.includes(id), `v1 all leaves out ${id}`);
  const map = await sitemapXml();
  assert.ok(!map.includes("/items/") && !map.includes("/story/") && !map.includes("/daily"), "the sitemap lists only the live public pages");
  const llms = llmsTxt({ hasDailies: true, hasWeekly: true, hasMonthly: true, hasLeaderboard: true });
  for (const gone of ["/hot)", "/all)", "/topics)", "/agent)", "/leaderboard)", "links.topka"]) assert.ok(!llms.includes(gone), `llms.txt drops ${gone}`);
  // The terms and privacy pages are off (SITE.legalPages false): nothing machine-readable links them.
  for (const off of ["/terms", "/privacy"]) {
    assert.ok(!map.includes(off), `the sitemap leaves out ${off}`);
    assert.ok(!llms.includes(off), `llms.txt leaves out ${off}`);
  }
});

test("an editor's override can bring an item into scope", async () => {
  await sql`INSERT INTO editorial_overrides (article_id, fields, updated_by) VALUES (${ids.battery!}, ${sql.json({ inScope: true })}, 'tester')
    ON CONFLICT (article_id) DO UPDATE SET fields = EXCLUDED.fields`;
  await publishArticle(ids.battery!);
  const [row] = await sql<{ in_scope: boolean; selected: boolean }[]>`SELECT in_scope, selected FROM publications WHERE article_id = ${ids.battery!}`;
  assert.equal(row!.in_scope, true);
});
