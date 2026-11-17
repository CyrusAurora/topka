// The online demo's own chrome (the bar above every page), in both languages.
export const DEMO_STRINGS = {
  "zh-CN": {
    badge: "在线体验",
    lead: "今日和往期是一个真实运行的 Topka 每天定稿的内容；对话和建项目由浏览器里的演示模型回答，只存在你的浏览器里。",
    updated: (when: string) => `数据更新于 ${when}`,
    latest: (date: string) => `最新一期：${date}`,
    stale: (days: number) => `已经 ${days} 天没有更新（供数据的机器在休眠），不是今天的内容。`,
    noData: "还没有导出的数据。",
    selfHost: "自己部署",
    source: "源代码",
    language: "语言",
    timeZone: "时区",
    infoTitle: "这一页要在自己部署的 Topka 上用",
    infoBody: "在线体验版没有服务器：账号、登录、提醒和反馈都需要你自己部署一个 Topka。部署只要几条命令，不需要付费服务。",
    notFound: "没有这个页面。",
    home: "回到今日",
  },
  en: {
    badge: "Online demo",
    lead: "Today and Past issues are the real daily picks of a running Topka. Chat and project creation are answered by the demo model in your browser and stay in your browser.",
    updated: (when: string) => `Data updated ${when}`,
    latest: (date: string) => `Latest issue: ${date}`,
    stale: (days: number) => `Not updated for ${days} days (the machine that feeds it is asleep); this is not today's issue.`,
    noData: "No exported data yet.",
    selfHost: "Self-host",
    source: "Source code",
    language: "Language",
    timeZone: "Time zone",
    infoTitle: "This page needs a self-hosted Topka",
    infoBody: "The online demo has no server: accounts, sign-in, reminders and feedback need your own Topka. Setting one up takes a few commands and no paid service.",
    notFound: "No such page.",
    home: "Back to Today",
  },
} as const;

/** Zones offered in the bar (the reader's own zone is added when it is not here). */
export const DEMO_ZONES = ["Asia/Shanghai", "Asia/Taipei", "Asia/Tokyo", "Asia/Singapore", "Asia/Kolkata", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "UTC"];

/** Whole days between the export and now (0 the same day). */
export function staleDays(updatedAt: string | null | undefined, now: number): number {
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 86_400_000));
}
