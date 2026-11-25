// Evidence discipline (projects/evidence.ts): a candidate without enough evidence is left out of the
// daily issue — no link, nothing but a title, too little text, an anonymous claim nobody else reports,
// or a claim another report denies. Background mentions (an earlier report, a rumour site's name, a
// denial of a side detail) do not count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessEvidence, leadOf, textUnits, titleOverlap, type EvidenceInput } from "@topka/backend/projects/evidence";

const BODY_EN = "The company released the model today with a technical report and open weights. It was trained on two thousand hours of robot data and tested on three platforms, with every task's success rate listed in the report and a public demo.";
const BODY_ZH = "公司今天在发布会上公布了这项进展，并给出了技术报告、演示视频和第一批客户名单，报告列出了每项测试的数据和对比方法，产品将在下个季度开始交付。";

const base = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  url: "https://example.com/a", title: "Acme releases a humanoid policy model", body: BODY_EN, excerpt: "", postText: "",
  firstParty: false, upstreams: 1, otherReports: [], ...over,
});

const reason = (e: EvidenceInput) => {
  const v = assessEvidence(e);
  return v.sufficient ? "ok" : v.reason;
};

test("text units count CJK characters and Latin words alike", () => {
  assert.equal(textUnits("机器人 robot arm 2.0"), 6);
  assert.equal(textUnits(""), 0);
  assert.ok(textUnits(BODY_ZH) >= 40);
});

test("a normal report with a link and a body is enough, in either language", () => {
  assert.equal(reason(base()), "ok");
  assert.equal(reason(base({ title: "公司发布人形机器人模型", body: BODY_ZH })), "ok");
  // The feed summary or the post text can carry the text instead of the body.
  assert.equal(reason(base({ body: "", excerpt: BODY_EN })), "ok");
  assert.equal(reason(base({ body: "", postText: BODY_EN })), "ok");
});

test("no link, a title only, or too little text: abstain", () => {
  assert.equal(reason(base({ url: null })), "no-source");
  assert.equal(reason(base({ url: "not a url" })), "no-source");
  assert.equal(reason(base({ body: "", excerpt: "", postText: "" })), "title-only");
  assert.equal(reason(base({ body: "One line about the launch." })), "thin");
});

test("an anonymous claim with one upstream abstains; a named outlet, the company or a second upstream lifts it", () => {
  const rumour = base({ title: "Acme reportedly plans a humanoid IPO", body: `People familiar with the matter say Acme plans to list next year. ${BODY_EN}` });
  assert.equal(reason(rumour), "unsourced-claim");
  assert.equal(reason({ ...rumour, upstreams: 2 }), "ok");
  assert.equal(reason({ ...rumour, firstParty: true }), "ok");
  assert.equal(reason({ ...rumour, body: `Acme plans to list next year, according to Bloomberg. ${BODY_EN}` }), "ok");
  assert.equal(reason({ ...rumour, title: "Acme confirms humanoid IPO plans" }), "ok");
  assert.equal(reason(base({ title: "知情人士：某公司计划明年上市", body: `据知情人士透露，${BODY_ZH}` })), "unsourced-claim");
  assert.equal(reason(base({ title: "消息称某公司将推出新机器人", body: BODY_ZH })), "unsourced-claim");
  assert.equal(reason(base({ title: "曝某公司新机器人售价", body: BODY_ZH })), "unsourced-claim");
});

test("sourcing words that are background or part of another word do not count", () => {
  // Later in the text, not the claim.
  assert.equal(reason(base({ body: `${BODY_EN} Some rumors say a second model is coming.` })), "ok");
  // "MacRumors", "数据传输", "曝光".
  assert.equal(reason(base({ title: "Shoppers on MacRumors forums wait for the robot", body: `On the MacRumors forums buyers compared notes. ${BODY_EN}` })), "ok");
  assert.equal(reason(base({ title: "芯片的数据传输机制详解", body: BODY_ZH })), "ok");
  assert.equal(reason(base({ title: "曝光：工厂里的机器人", body: BODY_ZH })), "ok");
  // The outlet named before the verb: "彭博社记者古尔曼爆料".
  assert.equal(reason(base({ title: "苹果被曝的新产品早已有人做出", body: `近日，彭博社记者马克·古尔曼爆料，苹果正在研发新设备。${BODY_ZH}` })), "ok");
});

test("a denial in the story counts against a reported claim or the very claim, not against a side detail", () => {
  const denial = "Acme denies report it plans a humanoid IPO";
  const rumour = base({ title: "Acme reportedly plans a humanoid IPO", upstreams: 3, otherReports: [denial] });
  assert.equal(reason(rumour), "source-conflict");
  // The item's own title repeated by the denial.
  assert.equal(reason(base({ title: "Acme plans a humanoid IPO", upstreams: 3, otherReports: [denial] })), "source-conflict");
  // A denial of something else in the same story.
  assert.equal(reason(base({ title: "Acme names a new chief executive", upstreams: 3, otherReports: ["Acme denies any leak of customer data"] })), "ok");
  // The denial itself is not contradicted by itself.
  assert.equal(reason(base({ title: denial, otherReports: ["Acme reportedly plans a humanoid IPO"] })), "ok");
});

test("the lead is the title and the first sentence", () => {
  assert.equal(leadOf("T", "First sentence is here. Second one.").trim(), "T\nFirst sentence is here.");
  assert.equal(leadOf("T", "短"), "T\n短");
  assert.ok(titleOverlap("Acme plans a humanoid IPO", "Acme denies it plans a humanoid IPO") >= 0.6);
  assert.equal(titleOverlap("", "x"), 0);
  assert.ok(titleOverlap("英伟达启动独立调查", "美国情报机构调查间谍活动") < 0.6);
});
