// The 今日 card copy budget: width units in pure functions, and every broken limit reported by
// field so the model can rewrite the broken half instead of anything being cut on the card.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDGET, budgetProblems, titleGap, titleUnits, widthUnits, type CopyFields } from "@topka/backend/projects/copy-budget";

const valid = (): CopyFields => ({
  title_a: "Pollen 开源双足机器人",
  title_b: "Microduck",
  core_a: "开源硬件配齐 sim-to-real 流程，",
  core_b: "个人也能训练双足行走。",
  summary: "记".repeat(80),
  tag: "sim-to-real",
  source: "Hugging Face",
});

test("widthUnits measures CJK at 1, Latin and half-width signs at 0.55, spaces at 0.3", () => {
  assert.equal(widthUnits("SuperMimic：单卡 3 小时，"), 12.65);
  assert.equal(widthUnits("开源硬件配齐 sim-to-real 流程，"), 15.65);
  assert.equal(widthUnits("个人也能训练双足行走。"), 11);
  assert.equal(widthUnits("whole-body control 训练降到单卡，"), 16.95);
  assert.equal(widthUnits(" "), 0.3);
  assert.equal(widthUnits("π"), 0.55);
});

test("titleGap and titleUnits: a space between halves unless title_a ends glued", () => {
  assert.equal(titleGap("RoboCasa-Shift："), false);
  assert.equal(titleGap("Pollen 开源双足机器人"), true);
  assert.equal(titleGap("双足机器人（"), false);
  assert.equal(titleUnits("Pollen 开源双足机器人", "Microduck"), 15.85);
  assert.equal(titleUnits("Pollen 开源双足机器人", ""), 10.6);
  // 「RoboCasa-Shift：」 ends glued, so no space is measured between the halves.
  assert.equal(titleUnits("RoboCasa-Shift：", "单卡"), widthUnits("RoboCasa-Shift：") + widthUnits("单卡"));
});

test("fully valid item copy reports nothing", () => {
  assert.deepEqual(budgetProblems(valid(), false), []);
});

test("hero layout: a core half that fits an item but not a hero is the only problem", () => {
  const copy = { ...valid(), core_a: "whole-body control 训练降到单卡，" };
  assert.deepEqual(budgetProblems(copy, true), [{ field: "core_a", units: 16.95, limit: BUDGET.heroCore, kind: "over" }]);
  assert.deepEqual(budgetProblems(copy, false), []);
});

test("a wide title_a is reported on title_a only", () => {
  const copy = { ...valid(), title_a: "SuperMimic：单卡 3 小时，" };
  const problems = budgetProblems(copy, false);
  assert.equal(problems.length, 1);
  assert.deepEqual(problems[0], { field: "title_a", units: 12.65, limit: BUDGET.titleA, kind: "over" });
});

test("a long title_b is reported with the combined title width, hero and item limits apart", () => {
  const copy = { ...valid(), title_b: "双足仿真平台工具链数据与评测基准全套开源发布" };
  for (const hero of [false, true]) {
    const [problem] = budgetProblems(copy, hero);
    assert.deepEqual(problem, { field: "title_b", units: 32.9, limit: hero ? BUDGET.heroTitle : BUDGET.itemTitle, kind: "over" });
  }
});

test("summary, tag and source report under, over and empty respectively", () => {
  const copy = valid();
  assert.deepEqual(budgetProblems({ ...copy, summary: "记".repeat(30) }, false), [{ field: "summary", units: 30, limit: BUDGET.summaryMin, kind: "under" }]);
  assert.deepEqual(budgetProblems({ ...copy, summary: "记".repeat(121) }, false), [{ field: "summary", units: 121, limit: BUDGET.summaryMax, kind: "over" }]);
  const longTag = "abcdefghi0123456789";
  assert.equal([...longTag].length, 19);
  assert.deepEqual(budgetProblems({ ...copy, tag: longTag }, false), [{ field: "tag", units: 19, limit: BUDGET.tagChars, kind: "over" }]);
  assert.deepEqual(budgetProblems({ ...copy, source: "" }, false), [{ field: "source", units: 0, limit: BUDGET.source, kind: "empty" }]);
});
