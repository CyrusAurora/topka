// UI strings: legal pages and their frame. `zh` is the Chinese copy as the product has it; `en` the same keys in English.
import type { Shape } from "./shape.ts";

export const zh = {
  terms: "使用规则",
  termsDescription: "本站网站、RSS、公开 API 与 MCP 的使用规则。",
  privacy: "隐私说明",
  privacyDescription: "本站如何处理浏览器本地数据、反馈资料与访问日志。",
  agent: "Agent 接入页",
  feedback: "反馈页",
  docInfo: "文档信息",
  outline: "目录",
  /** Labels for the document's front matter (its keys stay as written in industry/pages/*.md). */
  facts: { version: "版本", effective: "生效日期", operator: "运营主体", icp: "备案号" },
};

export const en: Shape<typeof zh> = {
  terms: "Terms of use",
  termsDescription: "Terms for this site, its RSS feeds, public API and MCP.",
  privacy: "Privacy",
  privacyDescription: "How this site handles data in your browser, feedback and access logs.",
  agent: "Agent access",
  feedback: "Feedback",
  docInfo: "Document",
  outline: "Contents",
  facts: { version: "Version", effective: "Effective", operator: "Operator", icp: "ICP filing" },
};
