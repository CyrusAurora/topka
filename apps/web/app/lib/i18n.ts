// Reader and admin UI strings (ADR 0004): zh-CN | en. Every user-visible string lives in a
// dictionary under ./locales/ (one file per area, each exporting `zh` and `en`); components read the
// reader's locale from <LocaleProvider> (set by root.tsx from the signed-in user, else SITE_LOCALE).
// Industry terms stay in their original form in both languages.
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import type { Shape } from "./locales/shape.ts";
import * as shell from "./locales/shell.ts";
import * as magazine from "./locales/magazine.ts";
import * as today from "./locales/today.ts";
import * as chat from "./locales/chat.ts";
import * as settings from "./locales/settings.ts";
import * as projects from "./locales/projects.ts";
import * as about from "./locales/about.ts";
import * as feedback from "./locales/feedback.ts";
import * as account from "./locales/account.ts";
import * as legal from "./locales/legal.ts";
import * as common from "./locales/common.ts";
import * as adminShell from "./locales/adminShell.ts";
import * as adminContent from "./locales/adminContent.ts";
import * as adminRuns from "./locales/adminRuns.ts";
import * as adminSources from "./locales/adminSources.ts";
import * as adminConfig from "./locales/adminConfig.ts";
import * as problems from "./locales/problems.ts";
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


export function navStrings(locale: UiLocale): NavStrings {
  return messages(locale).nav;
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
  home: (name: string) => string;
  feedTitle: (name: string) => string;
  notFoundMeta: string;
  loadErrorMeta: string;
}


export function chromeStrings(locale: UiLocale): ChromeStrings {
  return messages(locale).chrome;
}

// ---------------------------------------------------------------------------------------------
// Dictionaries by area. Add an area: create ./locales/<area>.ts with `zh` and `en: Shape<typeof zh>`,
// then list it in both objects below (the key-set test in tests/i18n.test.ts compares them).
// ---------------------------------------------------------------------------------------------

const ZH_MESSAGES = {
  ...shell.zh,
  magazine: magazine.zh,
  today: today.zh,
  chat: chat.zh,
  settings: settings.zh,
  projects: projects.zh,
  about: about.zh,
  feedback: feedback.zh,
  account: account.zh,
  legal: legal.zh,
  common: common.zh,
  adminShell: adminShell.zh,
  adminContent: adminContent.zh,
  adminRuns: adminRuns.zh,
  adminSources: adminSources.zh,
  adminConfig: adminConfig.zh,
  problems: problems.zh,
};
/** The dictionary's shape; every locale has exactly these keys (tests/i18n.test.ts). */
export type Messages = Shape<typeof ZH_MESSAGES>;
const EN_MESSAGES: Messages = {
  ...shell.en,
  magazine: magazine.en,
  today: today.en,
  chat: chat.en,
  settings: settings.en,
  projects: projects.en,
  about: about.en,
  feedback: feedback.en,
  account: account.en,
  legal: legal.en,
  common: common.en,
  adminShell: adminShell.en,
  adminContent: adminContent.en,
  adminRuns: adminRuns.en,
  adminSources: adminSources.en,
  adminConfig: adminConfig.en,
  problems: problems.en,
};

export function messages(locale: UiLocale): Messages {
  return locale === "en" ? EN_MESSAGES : ZH_MESSAGES;
}

/** The reader's display preferences: UI language and the IANA zone times are shown in. */
export interface UiPrefs {
  locale: UiLocale;
  timeZone: string;
}
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_PREFS: UiPrefs = { locale: "zh-CN", timeZone: DEFAULT_TIME_ZONE };

/** A valid IANA zone or the default (an unknown zone would make Intl throw while rendering). */
export function normalizeTimeZone(v: unknown): string {
  if (typeof v !== "string" || !v) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return v;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

const PrefsContext = createContext<UiPrefs>(DEFAULT_PREFS);

export function LocaleProvider({ locale, timeZone, children }: { locale: UiLocale; timeZone?: string; children?: ReactNode }) {
  const value = useMemo(() => ({ locale, timeZone: normalizeTimeZone(timeZone) }), [locale, timeZone]);
  return createElement(PrefsContext.Provider, { value }, children);
}

export function useUiPrefs(): UiPrefs {
  return useContext(PrefsContext);
}
export function useLocale(): UiLocale {
  return useContext(PrefsContext).locale;
}
/** The dictionary for the reader's locale. */
export function useT(): Messages {
  return messages(useContext(PrefsContext).locale);
}

/** BCP 47 tag for Intl formatters. */
export function intlLocale(locale: UiLocale): string {
  return locale === "en" ? "en-US" : "zh-CN";
}

/**
 * The page's locale inside a route's `meta` (no hooks there): the root loader's, else the default.
 * `export const meta: Route.MetaFunction = ({ matches }) => { const t = messages(localeOf(matches)); ... }`
 */
export function localeOf(matches: ReadonlyArray<unknown> | undefined): UiLocale {
  const root = (matches ?? []).find((m) => (m as { id?: string } | undefined)?.id === "root") as { loaderData?: { locale?: unknown }; data?: { locale?: unknown } } | undefined;
  return normalizeUiLocale(root?.loaderData?.locale ?? root?.data?.locale);
}

/** What a page shows for an API problem: the API's own detail on a Chinese page (it writes Chinese),
 *  the message for its code on an English page, else the page's own fallback. */
export function problemMessage(
  locale: UiLocale,
  problem: { code?: string; detail?: string; status?: number; retryAfter?: number } | null | undefined,
  fallback: string,
): string {
  if (locale === "zh-CN") return problem?.detail || fallback;
  if (problem?.detail && !/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(problem.detail)) return problem.detail;
  const t = messages(locale).problems;
  if (problem?.code === "rate_limited" || problem?.status === 429) return t.rateLimited(problem?.retryAfter ?? null);
  return (problem?.code && t.byCode[problem.code]) || fallback;
}
