// Project-aware scoring (editorial/project-score.ts): an article whose source tracking projects follow is
// scored against those projects' intent in the same two calls the generic score makes (one key per
// project); the best project's score stands in for the generic one; each (project, article) score is
// stored; an unchanged article is never scored again; a source no project follows keeps the generic prompt.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { analyzeArticle, scoreForProjects } from "@topka/backend/editorial/analyze";
import { projectScoreSystem, projectsForArticle } from "@topka/backend/editorial/project-score";
import { publishArticle } from "@topka/backend/publication/publish";
import { scoreDiscoveredForProjects } from "@topka/backend/projects/discovered";
import { createProject } from "@topka/backend/projects/create-project";
import { stopBoss } from "@topka/backend/jobs/queue";

const T = tag();
const LINKED = `test-pscore-${T}`;
const LONE = `test-pscore-lone-${T}`;
interface Req { step: string; system: string; user: string }
const requests: Req[] = [];

const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = system.includes("宽召回的AI相关性预筛") ? "prefilter" : system.includes("项目相关性评分器") ? "project-score"
    : system.includes("事件注意力评分器") ? "score" : system.includes("内容理解编辑") ? "understand" : system.includes("资料结构化助手") ? "structure" : "summarize";
  requests.push({ step, system, user });
  const answer = (content: unknown) => ({ id: `stub-${requests.length}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: "PASS", reason: "测试" });
  if (step === "project-score") return answer({ projectScores: { P1: requests.filter((r) => r.step === "project-score").length === 1 ? 81 : 77, P2: 12 } });
  if (step === "score") return answer({ attentionScore: 66 });
  if (step === "understand") return answer({ itemType: "research_paper", authorRole: "principal", tags: [], editorialJudgment: "理由", titleZh: "理解标题", summaryZh: "理解摘要。第二句。" });
  if (step === "structure") return answer({ category: "ai-models", tags: [], subjects: [], fact: null });
  return answer("title_zh: 翻译标题\nsummary_zh: 翻译摘要。第二句。");
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

let robots: string;
let finance: string;
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${LINKED}, 'Project score source', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${LONE}, 'Unfollowed source', 'rss', 'T1', 'editorial', '2100-01-01')`;
  await sql`INSERT INTO users (id, email, password_hash) VALUES (${`u-${T}`}, ${`pscore-${T}@example.com`}, 'x')`;
  robots = (await createProject({ ownerId: `u-${T}`, target: `人形机器人 ${T}`, purpose: "跟踪 VLA 与人形机器人进展", sources: [{ sourceId: LINKED, required: false }] })).project.id;
  finance = (await createProject({ ownerId: `u-${T}`, target: `消费金融 ${T}`, purpose: "跟踪监管变化", sources: [{ sourceId: LINKED, required: false }] })).project.id;
  await sql`UPDATE tracking_projects SET focus = '灵巧手、全身控制', exclusions = '纯软件大模型新闻' WHERE id = ${robots}`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

const material = async (source: string, n: string) =>
  (await upsertMaterial({
    sourceId: source, url: `https://example.com/pscore-${T}/${n}`, title: `A humanoid robot learns dexterous grasping ${n} ${T}`,
    bodyText: `${"A lab released a VLA model for humanoid hands with benchmark results. ".repeat(6)} (${T} ${n})`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never)).articleId;

test("the prompt carries each project's intent and keys, keeps the safety boundary and drops the fixed reader", () => {
  const text = projectScoreSystem([
    { id: "p1", revision: 1, target: "人形机器人", purpose: "跟踪进展", focus: "灵巧手", exclusions: "大模型" },
    { id: "p2", revision: 1, target: "消费金融", purpose: "跟踪监管", focus: "", exclusions: "" },
  ]);
  for (const s of ["### P1", "- 对象：人形机器人", "- 关注重点：灵巧手", "- 排除：大模型", "### P2", "输入安全边界", "不切题的材料，无论在行业里多大，最终分数不得高于 20", '{"projectScores":{"P1":0,"P2":0}}']) assert.ok(text.includes(s), s);
  assert.ok(!text.includes("持续关注 AI、但注意力有限"), "no fixed AI reader");
  assert.ok(!text.includes("- 关注重点：\n") && !/### P2\n.*\n.*\n- 关注重点/.test(text), "empty fields are left out");
});

test("a followed source: two calls score every project at once; the best project's mean stands in for the generic score", async () => {
  const id = await material(LINKED, "one");
  const res = await analyzeArticle(id);
  const steps = requests.map((r) => r.step);
  assert.equal(steps.filter((s) => s === "project-score").length, 2, "the same two calls");
  assert.equal(steps.filter((s) => s === "score").length, 0, "no extra generic calls");
  assert.equal(res!.output!.score, 79, "max per call (81, 77), mean floored");
  assert.equal(res!.output!.selected, true);
  const rows = await sql<{ project_id: string; scores: number[]; score: number; source_id: string }[]>`
    SELECT project_id, scores, score, source_id FROM project_scores WHERE article_id = ${id} ORDER BY score DESC`;
  assert.deepEqual(rows.map((r) => [r.project_id, r.scores, r.score, r.source_id]), [[robots, [81, 77], 79, LINKED], [finance, [12, 12], 12, LINKED]]);
  const ps = requests.find((r) => r.step === "project-score")!;
  assert.ok(ps.system.includes(`人形机器人 ${T}`) && ps.system.includes(`消费金融 ${T}`));
  assert.ok(ps.user.includes("只输出 projectScores"));

  const before = requests.length;
  const again = await scoreForProjects(id);
  assert.equal(requests.length, before, "unchanged article and projects: receipts reused, no call");
  assert.deepEqual(again!.map((r) => r.values), [[81, 77], [12, 12]]);
});

test("a source no project follows keeps the generic score and adds no project rows", async () => {
  const id = await material(LONE, "lone");
  const n = requests.length;
  const res = await analyzeArticle(id);
  const steps = requests.slice(n).map((r) => r.step);
  assert.deepEqual(steps.filter((s) => s.includes("score")), ["score", "score"]);
  assert.equal(res!.output!.score, 66);
  assert.equal((await sql`SELECT 1 FROM project_scores WHERE article_id = ${id}`).length, 0);
});

test("a followed source's prefilter also passes what its projects follow; an unfollowed one keeps the AI rule", async () => {
  const n = requests.length;
  await analyzeArticle(await material(LINKED, "prefilter"));
  const followed = requests.slice(n).find((r) => r.step === "prefilter")!;
  assert.ok(followed.system.includes("补充规则") && followed.system.includes(`人形机器人 ${T}`) && followed.system.includes(`消费金融 ${T}`));
  const m = requests.length;
  await analyzeArticle(await material(LONE, "prefilter-lone"));
  const lone = requests.slice(m).find((r) => r.step === "prefilter")!;
  assert.ok(!lone.system.includes("补充规则") && !lone.system.includes(T));
});

test("a report a broad feed stored first belongs to the projects whose source listed it too; the sweep scores it once", async () => {
  const id = await material(LONE, "shared");
  await analyzeArticle(id);
  await publishArticle(id);
  assert.equal((await projectsForArticle(id)).length, 0);
  // The followed source lists the same URL: one article, one more discovery.
  const again = await material(LINKED, "shared");
  assert.equal(again, id);
  assert.deepEqual((await projectsForArticle(id)).map((p) => p.id).sort(), [robots, finance].sort());
  await scoreDiscoveredForProjects({ max: 500 });
  const rows = await sql<{ project_id: string }[]>`SELECT project_id FROM project_scores WHERE article_id = ${id}`;
  assert.deepEqual(rows.map((r) => r.project_id).sort(), [robots, finance].sort());
  const n = requests.length;
  await scoreDiscoveredForProjects({ max: 500 });
  assert.equal(requests.slice(n).filter((r) => r.user.includes(`shared ${T}`)).length, 0, "scored once");
});
