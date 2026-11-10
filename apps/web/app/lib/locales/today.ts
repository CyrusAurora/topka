// UI strings: today. `zh` is the Chinese copy as the product has it; `en` the same keys in English.
import type { Shape } from "./shape.ts";

export const zh = {
  title: "今日",
  metaDescription: (site: string) => `${site} 项目的今日更新。`,
  loading: "正在读今天的更新……",
  signedOut: "请先登录。",
  goSignIn: "去登录",
  notFound: "没有这个项目。",
  failed: "暂时打不开，请稍后再试。",
  ack: "看完了",
  ackDone: "已记住这次读到的位置。",
  ackFinePrint: "确认只是记住这一期的位置，不表示同意任何分析。",
  ackFailed: "没能记住位置，请稍后再试。",
  noImportantChange: "无重要变化",
  noChangeDetail: "自上次阅读以来，关注的来源里没有达到重要更新条件的新内容。这不表示什么都没发生。",
  notice: "全部内容仅为发布方声明、未独立核验；中文标题和摘要由模型生成，是分析，不是证据，以原文为准。",
  selectedSuffix: " · 精选",
  analysisBadge: "分析",
  viewOriginal: "看原文出处",
  awaitingAnalysis: (n: number) => `另有 ${n} 条新采集的内容还没分析，分析后才会出现在这里。`,
  projectFallback: "项目",
  sourcesLine: (purpose: string, active: number, since: string) => `${purpose} · ${active} 个来源 · 自 ${since} 起`,
};

/** "1 source", "2 sources". */
const n_ = (n: number | string, one: string, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;

export const en: Shape<typeof zh> = {
  title: "Today",
  metaDescription: (site: string) => `Today's updates on your projects at ${site}.`,
  loading: "Loading today's updates…",
  signedOut: "Please sign in first.",
  goSignIn: "Sign in",
  notFound: "This project does not exist.",
  failed: "Could not open this right now. Try again shortly.",
  ack: "Done reading",
  ackDone: "Reading position saved.",
  ackFinePrint: "Confirming only saves your place in this issue; it does not mean you agree with any analysis.",
  ackFailed: "Could not save your reading position. Try again shortly.",
  noImportantChange: "No important changes",
  noChangeDetail: "Nothing new in the sources you follow has met the important-update bar since you last read. That does not mean nothing happened.",
  notice: "Everything here is what the publishers say, not independently verified; titles and summaries are written by a model: analysis, not evidence. The original prevails.",
  selectedSuffix: " · Selected",
  analysisBadge: "Analysis",
  viewOriginal: "View original",
  awaitingAnalysis: (n: number) =>
    n === 1
      ? "1 more newly collected item is waiting for analysis; it will appear here once analyzed."
      : `${n} more newly collected items are waiting for analysis; they will appear here once analyzed.`,
  projectFallback: "Project",
  sourcesLine: (purpose: string, active: number, since: string) => `${purpose} · ${n_(active, "source")} · since ${since}`,
};
