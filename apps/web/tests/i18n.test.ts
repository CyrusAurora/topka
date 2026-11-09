// Reader chrome catalog (ADR 0004 D): zh-CN matches current Chinese labels; en differs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeStrings, navStrings, normalizeUiLocale } from "../app/lib/i18n.ts";

test("zh-CN nav strings match current Chinese labels", () => {
  const s = navStrings("zh-CN");
  assert.deepEqual([s.today, s.archive, s.chat, s.settings, s.about, s.feedback], ["今日", "往期", "对话", "设置", "关于", "反馈"]);
});

test("en nav strings differ (Today etc.)", () => {
  const s = navStrings("en");
  assert.deepEqual([s.today, s.archive, s.chat, s.settings, s.about, s.feedback], ["Today", "Archive", "Chat", "Settings", "About", "Feedback"]);
});

test("theme + skip + error chrome: en differs, zh-CN is Chinese", () => {
  const zh = chromeStrings("zh-CN");
  const en = chromeStrings("en");
  assert.deepEqual([zh.dark, zh.light, zh.system], ["深色", "浅色", "跟随系统"]);
  assert.deepEqual([en.dark, en.light, en.system], ["Dark", "Light", "System"]);
  assert.equal(zh.backToToday, "回到今日");
  assert.equal(en.backToToday, "Back to Today");
  assert.equal(zh.skipToMain, "跳到正文");
  assert.equal(en.skipToMain, "Skip to content");
  assert.equal(zh.loginButton, "登录");
  assert.equal(en.loginTitle, "Sign in");
  assert.equal(zh.settingsTitle, "设置");
  assert.equal(en.settingsTitle, "Settings");
  assert.equal(normalizeUiLocale("en"), "en");
  assert.equal(normalizeUiLocale("junk"), "zh-CN");
});
