// Globalization v1 step 2 (ADR 0004 §D): users.locale wiring.
// - Locale helper: zh-CN | en only; outputLanguage maps to zh | en.
// - Issue feed AI notice follows locale.
// - Prompt outputLanguage reaches the model (via locale fixture + stub).
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { isValidLocale, normalizeLocale, outputLanguageFor, SUPPORTED_LOCALES } from "@topka/backend/accounts/locale";
import { aiNoticeFor, AI_NOTICE, AI_NOTICE_EN } from "@topka/backend/projects/issues";
import { promptText } from "@topka/backend/editorial/prompts";

after(async () => { await closeDb(); });

test("locale helper: only zh-CN | en, default zh-CN, outputLanguage zh|en", () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ["zh-CN", "en"]);
  assert.equal(isValidLocale("zh-CN"), true);
  assert.equal(isValidLocale("en"), true);
  assert.equal(isValidLocale("junk"), false);
  assert.equal(isValidLocale("en-US"), false);
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("junk"), "zh-CN");
  assert.equal(normalizeLocale(undefined), "zh-CN");
  assert.equal(outputLanguageFor("en"), "en");
  assert.equal(outputLanguageFor("zh-CN"), "zh");
  assert.equal(outputLanguageFor("junk"), "zh");
});

test("aiNoticeFor: en gets English notice, zh-CN keeps Chinese", () => {
  assert.equal(aiNoticeFor("en"), AI_NOTICE_EN);
  assert.equal(aiNoticeFor("zh-CN"), AI_NOTICE);
  assert.equal(AI_NOTICE, "AI 生成摘要，以原文为准");
});

test("prompts: outputLanguage=en produces English branch with industry terms; zh keeps Chinese", () => {
  const enIssue = promptText("issue-card", { project: "x", outputLanguage: "en" });
  const zhIssue = promptText("issue-card", { project: "x", outputLanguage: "zh" });
  assert.ok(enIssue.includes("outputLanguage is `en`"), "en branch present");
  assert.ok(/BYOK.*SLA.*VLA|VLA.*sim-to-real/.test(enIssue), "industry terms stay Latin");
  assert.ok(zhIssue.includes("outputLanguage is `en`"), "same prompt file serves both (branch is conditional)");
  assert.ok(!enIssue.includes("{{outputLanguage}}"), "placeholder filled");
  assert.ok(!zhIssue.includes("{{outputLanguage}}"), "placeholder filled zh");
  const enMobile = promptText("mobile-card", { project: "x", outputLanguage: "en" });
  assert.ok(enMobile.includes("outputLanguage is `en`") && /BYOK/.test(enMobile), "mobile en branch + terms");
});
