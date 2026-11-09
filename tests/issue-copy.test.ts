// The issue card copy writer: one card per item of a fixed issue, written for the phone's width
// budget (a field that comes back over budget goes back to the model with its overshoot, at most two
// rounds; what is still over is stored flagged, never truncated). The LLM is a local stub keyed on
// the issue-card prompt; no real provider is contacted. Each test gets its own project and
// publications: issue_card_copy is keyed (project_id, article_id), so the fixtures must not collide.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { createProject } from "@topka/backend/projects/create-project";
import { ISSUE_COPY_PROMPT_VERSION, MAX_REWRITES, cleanField, pangu, writeIssueCopy } from "@topka/backend/projects/issue-copy";
import { widthUnits } from "@topka/backend/projects/copy-budget";
import { stopBoss } from "@topka/backend/jobs/queue";

const T = tag();
const SRC = `ic-src-${T}`;
const OVER_CORE = "whole-body control 训练降到单卡，"; // 16.95 units against the hero limit of 16

const SUMMARY_A = "SuperMimic 用可微世界模型扩展人形全身控制，训练成本从 128 卡降到单卡 3 小时，成功率 91% 跑赢基线；代码已开源但只有预览版，还没完整复现家居长任务的成绩。";
const SUMMARY_B = "Pollen 开源了一整套双足机器人硬件，包括电机、板材和控制器图纸，随附 sim-to-real 训练流程；个人能按文档装出整机，训练脚本跑通，开源相机标定仍要手工做几步。";
const SUMMARY_C = "RoboCasa-Shift 用 128 个家居长任务给 VLA 模型做体检，最强的 openVLA 变体成功率 41%，全家桶基线是 17%；差距集中在长时序任务上，评测脚本已开源可以复现。";
for (const s of [SUMMARY_A, SUMMARY_B, SUMMARY_C]) assert(widthUnits(s) > 60 && widthUnits(s) < 120, "fixture summaries must satisfy the budget");

interface Card {
  title_a: string; title_b: string; core_a: string; core_b: string; summary: string; tag: string; source: string;
}
const CARD: Record<"A" | "B" | "C", Card> = {
  A: { title_a: "SuperMimic扩展全身控制", title_b: "单卡3小时", core_a: "可微世界模型扩展全身控制训练，", core_b: "个人也能训练双足行走。", summary: SUMMARY_A, tag: "whole-body control", source: "Hugging Face" },
  B: { title_a: "Pollen开源双足机器人", title_b: "Microduck", core_a: "开源硬件配齐 sim-to-real 流程，", core_b: "个人也能训练双足行走。", summary: SUMMARY_B, tag: "sim-to-real", source: "arXiv" },
  C: { title_a: "RoboCasa-Shift：", title_b: "给VLA的家居长任务做体检", core_a: "新基准覆盖 128 个家居长任务，", core_b: "对照组是全家桶基线。", summary: SUMMARY_C, tag: "数据集", source: "36氪" },
};
for (const [k, c] of Object.entries(CARD) as Array<["A" | "B" | "C", Card]>) {
  assert(widthUnits(cleanField(pangu(c.title_a))) <= 12, `fixture ${k} title_a must hold the standalone budget`);
  assert(widthUnits(cleanField(pangu(c.core_a))) <= 19 && widthUnits(cleanField(pangu(c.core_b))) <= 19, `fixture ${k} core must hold the item budget`);
}

let answer: (user: string) => unknown = () => ({ cards: [] });
const received: Array<{ user: string; rewrite: boolean; system: string }> = [];
const llm = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  const system = body.messages[0]!.content;
  const user = body.messages[body.messages.length - 1]!.content;
  const say = (o: unknown) => ({ id: "stub", model: "stub-model", choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
  if (system.includes("「今日」的编辑")) {
    received.push({ user, rewrite: user.startsWith("【重写】"), system });
    return say(answer(user));
  }
  return say({ action: "reply", projectRef: null, reply: "这里没有别的任务。", proposal: null });
});
Object.assign(process.env, { LLM_BASE_URL: `${llm.url}/v1`, LLM_API_KEY: "test", LLM_MODEL: "stub-model" });

let seq = 0;
type Keys = "A" | "B" | "C";
const writes = (arts: Record<Keys, string>, o: Partial<Record<Keys, Partial<Card> | false>> = {}) =>
  (["A", "B", "C"] as Keys[]).filter((k) => o[k] !== false).map((k) => ({ ...CARD[k], id: arts[k], ...(o[k] && typeof o[k] === "object" ? o[k] : {}) }));

type CopyRow = { article_id: string; title_a: string; title_b: string; core_a: string; core_b: string; summary: string; tag: string; source_short: string; over_budget: boolean };
const copyRows = (user: string) =>
  sql<CopyRow[]>`
    SELECT c.article_id, c.title_a, c.title_b, c.core_a, c.core_b, c.summary, c.tag, c.source_short, c.over_budget
    FROM issue_card_copy c
    JOIN user_issue_items ui ON ui.user_id = ${user} AND ui.article_id = c.article_id AND ui.project_id = c.project_id
    ORDER BY ui.position`;
const withId = (rows: CopyRow[], id: string) => rows.find((r) => r.article_id === id)!;
const rewrites = () => received.filter((r) => r.rewrite).map((r) => r.user);

/** One user, one project with three new publications, one issue with them under positions 1/2/3. */
async function issueOf(hero: boolean) {
  seq++;
  const user = `ic-user-${T}-${seq}`;
  const arts: Record<Keys, string> = { A: "", B: "", C: "" };
  await sql`INSERT INTO users (id, email, password_hash) VALUES (${user}, ${`${user}@example.com`}, 'x')`;
  const project = (await createProject({ ownerId: user, target: `具身智能 ${T}-${seq}`, purpose: "跟踪具身智能的重要进展", sources: [{ sourceId: SRC, required: false }] })).project.id;
  const listed = new Date(Date.now() - 10 * 60_000);
  for (const [i, k] of (["A", "B", "C"] as Keys[]).entries()) {
    const path = `ic-${T}-${seq}-${k}`;
    const id = (await upsertMaterial({ sourceId: SRC, url: `https://example.org/${path}`, title: `标题 ${path}`, bodyText: `Body of ${path}: 91% success.`, bodyStatus: "ok", via: "fetch", publishedAt: listed })).articleId;
    await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${id}`;
    await sql`INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, score, visible_after, listed_at)
              VALUES (${id}, ${`中文标题 ${path}`}, ${`标题 ${path}`}, ${`旧摘要 ${path}`}, ${SRC}, 'news', ${`https://example.org/${path}`}, ${listed}, ${listed}, ${listed}, ${listed}, true, 60, ${listed}, ${listed})`;
    arts[k] = id;
  }
  const date = `2026-10-${String(10 + seq)}`;
  const cutoff = new Date(Date.now() - 60_000);
  await sql`INSERT INTO user_issues (user_id, issue_date, issue_no, cutoff, window_since, hero) VALUES (${user}, ${date}, 1, ${cutoff}, ${cutoff}, ${hero})`;
  for (const [i, k] of (["A", "B", "C"] as Keys[]).entries()) {
    await sql`INSERT INTO user_issue_items (user_id, issue_date, position, article_id, project_id, story_id, score, listed_at)
              VALUES (${user}, ${date}, ${i + 1}, ${arts[k]}, ${project}, null, ${92 - i * 10}, ${cutoff})`;
  }
  return { user, date, arts };
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES (${SRC}, ${`Issue ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});

after(async () => {
  await llm.close();
  await stopBoss();
  await closeDb();
});

test("pangu: one space between a CJK char and an ASCII letter/digit, both directions, nothing else", () => {
  assert.equal(pangu("单卡3小时"), "单卡 3 小时");
  assert.equal(pangu("开源硬件配齐sim-to-real流程，"), "开源硬件配齐 sim-to-real 流程，");
  assert.equal(pangu("VLA评测"), "VLA 评测");
  assert.equal(pangu("128卡"), "128 卡");
  assert.equal(pangu("给VLA的家居长任务"), "给 VLA 的家居长任务");
  assert.equal(pangu("开源硬件 3 小时"), "开源硬件 3 小时", "existing spaces stay");
  assert.equal(pangu("whole-body control"), "whole-body control", "no space is doubled");
  assert.equal(pangu(""), "");
});

test("cleanField: collapse whitespace, unwrap wrapping quotes, never cut", () => {
  assert.equal(cleanField(undefined), "");
  assert.equal(cleanField(null), "");
  assert.equal(cleanField(42), "42");
  assert.equal(cleanField("  多个   空格\n还有换行  "), "多个 空格 还有换行");
  assert.equal(cleanField("「被包住」"), "被包住");
  assert.equal(cleanField("“被包住”"), "被包住");
  assert.equal(cleanField('"quoted"'), "quoted");
  assert.equal(cleanField("中间「不摘」的字"), "中间「不摘」的字");
});

test("issue copy: every field within budget on the first answer — 3 stored rows, not over, one call, pangu applied", async () => {
  const { user, date, arts } = await issueOf(false);
  answer = () => ({ cards: writes(arts) });
  const r = await writeIssueCopy(user, date);
  assert.deepEqual([r.stored, r.overBudget, r.calls, r.skipped], [3, 0, 1, []]);
  const rows = await copyRows(user);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.over_budget === false));
  assert.deepEqual([withId(rows, arts.A).title_a, withId(rows, arts.A).title_b], ["SuperMimic 扩展全身控制", "单卡 3 小时"], "pangu went into the stored title");
  assert.equal(withId(rows, arts.B).core_a, "开源硬件配齐 sim-to-real 流程，");
  assert.equal(withId(rows, arts.B).tag, "sim-to-real", "tag is not pangu'd — taken as it came");
  const write = received.at(-1)!;
  assert.equal(write.rewrite, false);
  assert.ok(write.user.includes(`【内容 id=${arts.A}】`), "each item carries its own block");
  assert.ok(write.user.includes("预算：title_a ≤ 12｜标题合计 ≤ 30｜core 每半 ≤ 19｜summary 60–120｜tag ≤ 18 字符｜source ≤ 14"));
  assert.equal(withId(rows, arts.A).summary, SUMMARY_A);
  assert.equal(withId(rows, arts.C).source_short, "36氪");
  assert.equal((await sql<{ prompt_version: string }[]>`SELECT prompt_version FROM issue_card_copy WHERE article_id = ${arts.A} LIMIT 1`)[0]!.prompt_version, ISSUE_COPY_PROMPT_VERSION);
  assert.deepEqual(await writeIssueCopy(user, date), { stored: 0, overBudget: 0, calls: 0, skipped: [] }, "written once — a second call has nothing to do");
});

test("a hero item over by 0.95 units: the rewrite lists that one field with its overshoot, the fix lands, over_budget false", async () => {
  const { user, date, arts } = await issueOf(true);
  answer = (u) => (u.startsWith("【重写】")
    ? { fixes: [{ id: arts.A, field: "core_a", text: "单卡就能跑全身控制训练，" }] }
    : { cards: writes(arts, { A: { core_a: OVER_CORE } }) });
  const r = await writeIssueCopy(user, date);
  assert.deepEqual([r.stored, r.overBudget, r.calls, r.skipped], [3, 0, 2, []]);
  const lines = rewrites();
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes(`id=${arts.A}｜字段 core_a｜现在「${OVER_CORE}」｜宽度 16.95，上限 16，超出 0.95`), "the overshoot is named");
  assert.equal(lines[0]!.split("\n").filter((l) => l.includes(`id=${arts.A}｜字段`)).length, 1, "only the broken field is listed");
  const rows = await copyRows(user);
  assert.deepEqual([withId(rows, arts.A).core_a, withId(rows, arts.A).over_budget], ["单卡就能跑全身控制训练，", false]);
  assert.equal(withId(rows, arts.B).over_budget, false, "the untouched cards still store");
});

test("still over after both rewrite rounds: stored flagged over_budget, never truncated", async () => {
  const { user, date, arts } = await issueOf(true);
  let rounds = 0;
  answer = (u) => {
    if (u.startsWith("【重写】")) { rounds++; return { fixes: [{ id: arts.A, field: "core_a", text: OVER_CORE }] }; }
    return { cards: writes(arts, { A: { core_a: OVER_CORE } }) };
  };
  const r = await writeIssueCopy(user, date);
  assert.deepEqual([r.stored, r.overBudget, r.calls], [3, 1, 1 + MAX_REWRITES]);
  assert.equal(rounds, MAX_REWRITES);
  const rows = await copyRows(user);
  assert.deepEqual([withId(rows, arts.A).core_a, withId(rows, arts.A).over_budget], [OVER_CORE, true], "kept whole");
  assert.equal(withId(rows, arts.B).over_budget, false);
  assert.equal(withId(rows, arts.C).over_budget, false);
});

test("an item the model forgot is skipped once and picked up by the next writeIssueCopy", async () => {
  const { user, date, arts } = await issueOf(false);
  answer = () => ({ cards: writes(arts, { C: false }) });
  const first = await writeIssueCopy(user, date);
  assert.deepEqual([first.stored, first.skipped], [2, [arts.C]]);
  answer = () => ({ cards: writes(arts, { A: false, B: false }) });
  const second = await writeIssueCopy(user, date);
  assert.deepEqual([second.stored, second.calls, second.skipped], [1, 1, []]);
  assert.equal((await copyRows(user)).length, 3);
});

test("a summary under budget is named with its minimum and fixed on the rewrite", async () => {
  const { user, date, arts } = await issueOf(false);
  answer = (u) => (u.startsWith("【重写】")
    ? { fixes: [{ id: arts.A, field: "summary", text: SUMMARY_A }] }
    : { cards: writes(arts, { A: { summary: "太短。" } }) });
  const r = await writeIssueCopy(user, date);
  assert.deepEqual([r.stored, r.overBudget, r.calls, r.skipped], [3, 0, 2, []]);
  assert.ok(rewrites().at(-1)!.includes(`id=${arts.A}｜字段 summary｜现在「太短。」｜宽度 3，至少 60`), "the minimum is named");
  assert.equal(withId(await copyRows(user), arts.A).summary, SUMMARY_A);
});

test("locale=en: system prompt includes outputLanguage=en and industry-terms rule (ADR 0004 D)", async () => {
  const { user, date, arts } = await issueOf(false);
  await sql`UPDATE users SET locale = 'en' WHERE id = ${user}`;
  const EN_CARD = {
    title_a: "SuperMimic expands control",
    title_b: "1 GPU in 3 hours",
    core_a: "Differential world model expands whole-body control,",
    core_b: "individuals can train bipedal walking.",
    summary: "SuperMimic scales humanoid whole-body control with a differentiable world model, cutting training from 128 GPUs to a single GPU in 3 hours with 91% success, beating the baseline; code is open-source but preview-only, lagging on long-horizon home tasks.",
    tag: "whole-body control",
    source: "Hugging Face",
  };
  answer = () => ({ cards: [
    { ...EN_CARD, id: arts.A },
    { ...EN_CARD, id: arts.B },
    { ...EN_CARD, id: arts.C },
  ] });
  const r = await writeIssueCopy(user, date);
  assert.equal(r.stored, 3);
  const sys = received.at(-1)!.system;
  assert.ok(sys.includes("en"), "outputLanguage token en in system prompt");
  assert.ok(sys.includes("BYOK") && sys.includes("VLA"), "industry terms rule present");
  // zh-CN path includes zh token too (new issue from default user)
  const zh = await issueOf(false);
  answer = () => ({ cards: writes(zh.arts) });
  await writeIssueCopy(zh.user, zh.date);
  assert.ok(received.at(-1)!.system.includes("zh"), "zh token in system prompt for zh-CN user");
});
