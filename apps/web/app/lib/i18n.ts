// Reader chrome strings for globalization v1 (ADR 0004 §D): zh-CN | en.
// Admin UI stays Chinese (not catalogued here). Industry terms stay Latin in both.
export const SUPPORTED_UI_LOCALES = ["zh-CN", "en"] as const;
export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

export function isUiLocale(v: unknown): v is UiLocale {
  return typeof v === "string" && (SUPPORTED_UI_LOCALES as readonly string[]).includes(v);
}
export function normalizeUiLocale(v: unknown): UiLocale {
  return isUiLocale(v) ? v : "zh-CN";
}

export interface NavStrings {
  today: string;
  archive: string;
  chat: string;
  settings: string;
  about: string;
  feedback: string;
  reading: string;
  more: string;
}

const ZH: NavStrings = {
  today: "今日",
  archive: "往期",
  chat: "对话",
  settings: "设置",
  about: "关于",
  feedback: "反馈",
  reading: "阅读",
  more: "更多",
};
const EN: NavStrings = {
  today: "Today",
  archive: "Archive",
  chat: "Chat",
  settings: "Settings",
  about: "About",
  feedback: "Feedback",
  reading: "Reading",
  more: "More",
};

export function navStrings(locale: UiLocale): NavStrings {
  return locale === "en" ? EN : ZH;
}

export interface ChromeStrings {
  skipToMain: string;
  backToToday: string;
  browseArchive: string;
  backToTop: string;
  mainNav: string;
  bottomNav: string;
  newUpdate: string;
  appearance: string;
  dark: string;
  light: string;
  system: string;
  notFoundTitle: string;
  loadErrorTitle: string;
  notFoundBody: string;
  loadErrorBody: string;
  settingsTitle: string;
  settingsHeading: string;
  localeLabel: string;
  localeZh: string;
  localeEn: string;
  loginTitle: string;
  loginButton: string;
  loggingIn: string;
  registerTitle: string;
  registerButton: string;
  registering: string;
  emailLabel: string;
  passwordLabel: string;
}

const ZH_CHROME: ChromeStrings = {
  skipToMain: "跳到正文",
  backToToday: "回到今日",
  browseArchive: "翻往期",
  backToTop: "回到顶部",
  mainNav: "主导航",
  bottomNav: "底部导航",
  newUpdate: "有新的更新",
  appearance: "外观",
  dark: "深色",
  light: "浅色",
  system: "跟随系统",
  notFoundTitle: "这里没有内容",
  loadErrorTitle: "暂时无法加载",
  notFoundBody: "你访问的页面不存在，或内容已不再公开。",
  loadErrorBody: "服务暂时繁忙，请稍后再试。已经加载过的内容不受影响。",
  settingsTitle: "设置",
  settingsHeading: "设置",
  localeLabel: "界面语言",
  localeZh: "简体中文",
  localeEn: "English",
  loginTitle: "登录",
  loginButton: "登录",
  loggingIn: "正在登录…",
  registerTitle: "注册",
  registerButton: "创建账号",
  registering: "正在注册…",
  emailLabel: "邮箱",
  passwordLabel: "密码",
};
const EN_CHROME: ChromeStrings = {
  skipToMain: "Skip to content",
  backToToday: "Back to Today",
  browseArchive: "Browse Archive",
  backToTop: "Back to top",
  mainNav: "Main navigation",
  bottomNav: "Bottom navigation",
  newUpdate: "New updates available",
  appearance: "Appearance",
  dark: "Dark",
  light: "Light",
  system: "System",
  notFoundTitle: "Nothing here",
  loadErrorTitle: "Could not load",
  notFoundBody: "This page does not exist, or is no longer public.",
  loadErrorBody: "The service is busy, please try again shortly. Already loaded content is unaffected.",
  settingsTitle: "Settings",
  settingsHeading: "Settings",
  localeLabel: "Interface language",
  localeZh: "简体中文",
  localeEn: "English",
  loginTitle: "Sign in",
  loginButton: "Sign in",
  loggingIn: "Signing in…",
  registerTitle: "Create account",
  registerButton: "Create account",
  registering: "Creating account…",
  emailLabel: "Email",
  passwordLabel: "Password",
};

export function chromeStrings(locale: UiLocale): ChromeStrings {
  return locale === "en" ? EN_CHROME : ZH_CHROME;
}
