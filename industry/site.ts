// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

export const SITE = {
  /** 站名：导航、页面标题、分享图、RSS、MCP、后台都用它。 */
  name: "Topka",
  /**
   * 行业词：拼进默认说法里，比如“AI 日报”“AI 动态”。
   * 改成“法律”“HR”“黄金”之类，页面上就会变成“法律日报”“法律动态”。
   */
  subject: "AI",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "Topka — 持续情报工作台 · 每日精选与事件追踪",
  /** 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。 */
  description: "声明你要盯什么、为什么盯；系统持续采集固定信源，把跨来源的重复报道归并成事件，回访时只给你带出处的重要更新。不够格就少发或当天不出，宁少不凑。",
  /** 首页左上角和侧边栏下面的一行小字。 */
  tagline: "盯住你在意的事，每条都有出处",
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /** Site content pool language (prompts write card copy in this unless a user's locale asks otherwise). */
  contentLanguage: "zh",
  /** 默认域名，只在没设置 SITE_URL 时使用。 */
  defaultUrl: "http://localhost:3000",
  /**
   * MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 topka_get_latest、topka_search……
   * 已经有人接入后就不要再改。
   */
  mcpPrefix: "topka",
  /** 对外联系邮箱（选填）：使用规则、llms.txt、响应头里会写。 */
  contactEmail: null as string | null,
  /**
   * 使用规则和隐私说明页（industry/pages/terms.md、privacy.md）是否公开。关着时 /terms、/privacy 回 404，
   * 页脚、反馈页、sitemap、llms.txt、OpenAPI 都不链接它们；文案和页面代码保留，填好运营者信息后改成 true。
   */
  legalPages: false as boolean,
  /** 页脚的一行小字（选填）。 */
  footerNote: "由 Topka 开源框架（MIT）驱动 · Topka 项目层",
  /** 中国大陆网站的 ICP 备案号（选填），填了就显示在页脚并链接到工信部备案系统。 */
  icp: null as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "Topka",
    /** 创始人（选填）：{ name, url, description }。 */
    founder: null as null | { name: string; url?: string; description?: string },
  },
  /** 抓取信源时报上的名字（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "TopkaBot",
} as const;

/** 关于页的文案。数字（信源数、收录数、精选数、日报期数）来自站内实时统计，不用写在这里。 */
export const ABOUT = {
  kicker: `关于 ${SITE.name}`,
  /** 大标题：第一行正常颜色，第二行强调色。 */
  headline: ["你盯的事，", "有新动静才来找你。"] as [string, string],
  /** 标题下面的一段话。{sources} 会换成实时的信源数。 */
  lead: `${SITE.name} 替你盯着 {sources} 个信源：抓取、归并成事件、按项目整理；每天早上 8 点出一份日报。`,
  /** 信源河动画下面的四个环节。 */
  steps: {
    collect: "官方博客、媒体、X 账号、公众号和各类订阅源都在看；活跃的源 15 分钟就看一次。",
    store: "抓到的都存下来，同一件事的报道归到一起；只计入热度的账号也算在内，热点榜就是从这里算出来的。",
    select: "模型先看是不是这个行业的事、有没有实际信息，再写中文标题、摘要和推荐理由；营销稿和重复转发进不来。",
    publish: "每天 08:00 出日报，周一出周报，每月 1 日出月报；最精选的几条可以推到飞书群。",
  },
  /**
   * 作者块（选填），null 就不显示。
   * avatarSourceId：一个 X 账号信源的 id，头像取它的（选填）。
   * 二维码在后台“设置”里上传，或者放进 industry/brand/contact/；没有二维码就不显示那张卡片。
   */
  maker: null as null | {
    name: string;
    greeting: string[];
    avatarSourceId?: string | null;
    wechat?: { title: string; note: string };
    feishu?: { title: string; note: string };
  },
  /** 页面底部的版权与下架说明（结尾会接“反馈页”的链接）。 */
  copyright: `${SITE.name} 是聚合摘要和阅读索引，原文版权归各来源所有。如果你是来源方，希望更正、下架或调整展示方式，可以通过`,
} as const;

/**
 * English copy for readers whose interface language is en (a user's locale, or SITE_LOCALE=en for the
 * whole instance). Same fields as the Chinese ones above; keep the two in step when you edit either.
 */
export const SITE_EN = {
  homeTitle: `${SITE.name} — continuous intelligence · a daily pick and event tracking`,
  description:
    "Say what you want to watch and why. The system keeps collecting from fixed sources, merges duplicate coverage across sources into events, and on each visit brings you only the important updates, each with its source. When nothing clears the bar it sends less, or skips the day: fewer, never padded.",
  tagline: "Watch what matters to you, every item sourced",
  footerNote: "Powered by the Topka open-source framework (MIT) · Topka project layer",
} as const;

export const ABOUT_EN = {
  kicker: `About ${SITE.name}`,
  headline: ["You name what to watch.", "It comes to you only when something moves."] as [string, string],
  lead: `${SITE.name} watches {sources} sources for you: it collects, merges coverage into events and sorts them by project, and puts out a daily issue every morning at 08:00.`,
  steps: {
    collect: "Official blogs, media, X accounts, WeChat official accounts and all kinds of feeds; active sources are checked every 15 minutes.",
    store: "Everything collected is kept, and coverage of the same story is grouped; accounts that only count toward heat are included, which is where the trending list comes from.",
    select: "A model first checks that it belongs to this field and carries real information, then writes the title, summary and reason; marketing copy and reposts stay out.",
    publish: "A daily issue at 08:00, a weekly on Mondays and a monthly on the 1st; the very best items can be pushed to a Feishu group.",
  },
  copyright: `${SITE.name} is an aggregated summary and reading index; copyright in the originals stays with each source. If you run a source and want something corrected, taken down or shown differently, reach us through the`,
} as const;

/** The site's reader-facing copy in a UI language ("en" or the Chinese default). */
export function siteCopy(locale: string): { homeTitle: string; description: string; tagline: string; footerNote: string } {
  return locale === "en" ? SITE_EN : SITE;
}

export interface AboutCopy {
  kicker: string;
  headline: readonly [string, string];
  lead: string;
  steps: { collect: string; store: string; select: string; publish: string };
  copyright: string;
  maker: typeof ABOUT.maker;
}

/** The about page's copy in a UI language; the maker block is the operator's own and is not translated. */
export function aboutCopy(locale: string): AboutCopy {
  return locale === "en" ? { ...ABOUT_EN, maker: ABOUT.maker } : ABOUT;
}

/** “AI 日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}
