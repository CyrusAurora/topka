// The Socratic intake engine (assistant/intake-core.cjs) shared by the web API, the server and
// outside clients: what each turn asks the model for, and what it keeps of the answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import typed from "../packages/backend/src/assistant/intake-core.cjs";

// Loose on purpose: the tests feed the engine raw model answers, including unusable ones.
const core = typed as any;

const now = 1_800_000_000_000;
const question = (q: string, options: string[], update = "") => ({ kind: "question", update, question: q, options, analysis: { vague: ["跟踪"] } });
const summary = { kind: "summary", update: "明白。", summary: { ask: "跟踪人形机器人", problem: "要不要投", facts: ["为投资"], assumptions: ["订单会兑现"], variables: ["订单量"], question: "一年内能否千台交付？" } };

test("routing: change/delete sentences go to the one-shot assistant, everything else to the intake", () => {
  assert.equal(core.routeOf("删掉人形机器人"), "manage");
  assert.equal(core.routeOf("修改人形机器人：多看灵巧手"), "manage");
  assert.equal(core.routeOf("帮我把这个项目删除"), "intake");
  assert.equal(core.routeOf("帮我跟踪人形机器人"), "intake");
});

test("a question carries its options plus 「其他」 last, and the update line first", () => {
  const plan = core.planTurn(null, "帮我跟踪人形机器人", now);
  assert.equal(plan.mode, "ask");
  const r = core.applyAnswer("ask", plan.session, question("关注哪类？", ["产业", "融资", "其他"], "明白，你要跟踪产业。"), {});
  assert.deepEqual(r.message.chips, ["产业", "融资", core.OTHER]);
  assert.equal(r.message.text, "明白，你要跟踪产业。\n关注哪类？");
  assert.equal(r.session.asked, 1);
  assert.equal(core.applyAnswer("ask", plan.session, question("只有一个选项？", ["产业"]), {}), null, "fewer than two options is unusable");
  assert.equal(core.parseJson("```json\n{\"kind\":\"question\"}\n```").kind, "question");
});

test("the answer is recorded; at the cap the next turn must summarize; confirm → card; 不对 asks what to change", () => {
  let s = core.planTurn(null, "跟踪机器人", now).session;
  for (let i = 0; i < core.MAX_QUESTIONS; i++) {
    s = core.applyAnswer("ask", s, question(`Q${i}`, ["a", "b"]), {}).session;
    const plan = core.planTurn(s, "a", now);
    assert.equal(plan.session.turns.at(-1).a, "a");
    s = plan.session;
    if (i === core.MAX_QUESTIONS - 1) assert.equal(plan.mode, "summarize");
  }
  assert.equal(core.applyAnswer("ask", s, question("再问一个", ["a", "b"]), {}), null, "never more than the cap");
  const conf = core.applyAnswer("summarize", s, summary, {});
  assert.equal(conf.message.kind, "confirm");
  assert.deepEqual(conf.message.chips, [core.CONFIRM_YES, core.CONFIRM_NO]);
  assert.equal(core.planTurn(conf.session, core.CONFIRM_YES, now).mode, "card");
  assert.equal(core.planTurn(conf.session, "对", now).mode, "card");
  const no = core.planTurn(conf.session, core.CONFIRM_NO, now);
  assert.equal(no.mode, "local");
  const fix = core.planTurn(conf.session, "时间改成两年", now);
  assert.deepEqual([fix.mode, fix.session.corrections], ["summarize", ["时间改成两年"]]);
  assert.equal(core.planTurn(conf.session, "重新开始", now).session, null);
  assert.equal(core.planTurn(conf.session, "x", now + core.SESSION_TTL_MS + 1).mode, "ask", "a stale session starts over");
});

test("the card: made-up sources dropped, key variables folded into what the project watches, the brief kept", () => {
  const s = core.applyAnswer("ask", core.planTurn(null, "跟踪人形机器人", now).session, summary, {}).session;
  assert.match(core.buildUser("card", s, { projects: [], catalog: [{ id: "s1", name: "源", enabled: true }] }), /s1｜源｜采集中/);
  const r = core.applyAnswer("card", s, { kind: "card", judgement: "值得跟。", reasons: ["订单在增"], next: "看订单公告", card: { target: "人形机器人", purpose: "", focus: ["订单"], exclusions: ["自动驾驶"], variables: ["交付量"], sourceIds: ["s1", "fake"] } }, { validSource: (id: string) => id === "s1" });
  const p = r.proposal;
  assert.deepEqual([p.target, p.focus, p.exclusions, p.sourceIds], ["人形机器人", "订单、交付量", "自动驾驶", ["s1"]]);
  assert.equal(p.purpose, "一年内能否千台交付？", "the project's purpose is the confirmed question");
  assert.deepEqual([p.intake.question, p.intake.judgement, p.intake.variables], ["一年内能否千台交付？", "值得跟。", ["交付量"]]);
  assert.match(r.message.text, /确认后才会创建/);
  assert.equal(core.finish(r.session, now).stage, "done");
  assert.equal(core.live(core.finish(r.session, now), now), false);
});

test("「manage」 from the model only counts on the very first turn", () => {
  const first = core.planTurn(null, "怎么删项目", now).session;
  assert.deepEqual(core.applyAnswer("ask", first, { kind: "manage" }, {}), { manage: true, session: null });
  const later = core.applyAnswer("ask", first, question("Q", ["a", "b"]), {}).session;
  assert.equal(core.applyAnswer("ask", later, { kind: "manage" }, {}), null);
});

test("真正的问题 is always the confirmed question sentence, never a topic", () => {
  const s = core.applyAnswer("ask", core.planTurn(null, "跟踪宁德时代固态电池", now).session, { kind: "summary", summary: { problem: "宁德时代固态电池2027年能否在乘用车上装车", question: "2027年宁德时代固态电池能否在乘用车实现装车？", variables: ["量产时间表"] } }, {}).session;
  const card = (purpose: string) => core.applyAnswer("card", s, { kind: "card", judgement: "偏早。", reasons: [], next: "", card: { target: "宁德时代固态电池", purpose, focus: "客户定点、装车计划", sourceIds: [] } }, {}).proposal;
  for (const purpose of ["宁德时代固态电池", "判断2027年能否装车", ""]) {
    const p = card(purpose);
    assert.equal(p.purpose, "2027年宁德时代固态电池能否在乘用车实现装车？");
    assert.equal(p.intake.question, "2027年宁德时代固态电池能否在乘用车实现装车？");
  }
  // A summary whose question is a topic: the problem sentence stands in if it asks something, else retry.
  const topic = (problem: string) => core.applyAnswer("ask", core.planTurn(null, "x", now).session, { kind: "summary", summary: { problem, question: "宁德时代固态电池", variables: [] } }, {});
  assert.equal(topic("宁德时代固态电池2027年能否装车").message.intake.question, "宁德时代固态电池2027年能否装车？");
  assert.equal(topic("宁德时代固态电池进展"), null);
  assert.equal(core.isQuestion("宁德时代固态电池"), false);
});

test("investment judgements say what to watch and the risks, never what to trade", () => {
  assert.equal(core.dropAdvice("一个月太短，净值波动大，单看涨跌容易追高被套，建议谨慎小仓试。", "F"), "一个月太短，净值波动大，单看涨跌容易追高被套。");
  assert.equal(core.dropAdvice("建议现在买入。", "F"), "F");
  assert.equal(core.dropAdvice("目前看2027年装车仍偏早。", "F"), "目前看2027年装车仍偏早。");
  const s = core.applyAnswer("ask", core.planTurn(null, "AI基金", now).session, { kind: "summary", summary: { problem: "AI基金能否持续上涨", question: "未来1个月AI基金净值能否跑赢沪深300？", variables: [] } }, {}).session;
  const r = core.applyAnswer("card", s, { kind: "card", judgement: "可以逢低加仓。", reasons: ["估值不高", "可以先建仓"], next: "明天买入一点", card: { target: "AI主题基金", purpose: "", focus: "净值", sourceIds: [] } }, {});
  assert.doesNotMatch(r.message.text, /加仓|建仓|买入/);
  assert.deepEqual(r.proposal.intake.reasons, ["估值不高"]);
});

test("an update line never frames the turn as a trade", () => {
  const s = core.planTurn(null, "想知道 AI 基金还能不能买", 1).session;
  const q = core.applyAnswer("ask", s, { kind: "question", update: "明白，你关心的是境内公募AI主题基金现在值不值得买。", question: "你想看多长时段？", options: ["1个月", "半年"] }, {});
  assert.doesNotMatch(q.message.text, /值得买|能买|入手|买入/);
  assert.match(q.message.text, /^明白/);
  assert.equal(q.message.text.split("\n").length, 2, "still one update line before the question");
  const ok = core.applyAnswer("ask", s, { kind: "question", update: "明白，你想看境内AI主题基金接下来的表现。", question: "你想看多长时段？", options: ["1个月", "半年"] }, {});
  assert.equal(ok.message.update, "明白，你想看境内AI主题基金接下来的表现。");
});

test("a guessed buying intent never lands on the card as an assumption", () => {
  const s = core.applyAnswer("ask", core.planTurn(null, "AI基金还能不能买", now).session, { kind: "summary", summary: { problem: "AI基金能否跑赢大盘", question: "未来1个月AI基金净值能否跑赢沪深300？", assumptions: ["用户有买入意向", "短期波动较大"], variables: [] } }, {});
  assert.deepEqual(s.message.intake.assumptions, ["短期波动较大"]);
});
