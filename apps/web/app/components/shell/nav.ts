// Localized (reader chrome) nav labels. Call sites pass the signed-in user's locale.
import type { ReactNode } from "react";
import { IconDoc, IconHeart, IconHistory, IconMessage, IconSun, IconUsers } from "../icons";
import type { NavTarget } from "./nav-match";
import { navStrings, type UiLocale } from "../../lib/i18n";

export { SETTINGS_PATHS, tabIsActive } from "./nav-match";

export interface NavItem extends NavTarget {
  to: string;
  /** Legacy zh-CN label; prefer localizedNav(). */
  label: string;
  icon: (p: { size?: number }) => ReactNode;
  end?: boolean;
  changelog?: boolean;
}

export interface LocalizedNavItem extends NavItem {
  localizedLabel: string;
}

function item(to: string, key: "today" | "archive" | "chat" | "settings" | "about" | "feedback", icon: NavItem["icon"], locale: UiLocale, extra: Partial<NavItem> = {}): LocalizedNavItem {
  const s = navStrings(locale);
  return { to, label: s[key], localizedLabel: s[key], icon, ...extra };
}

/** Desktop sidebar sections in the given locale (defaults zh-CN, matching SITE.locale). */
export function localizedSidebar(locale: UiLocale = "zh-CN"): Array<{ title: string; items: LocalizedNavItem[] }> {
  const s = navStrings(locale);
  return [
    {
      title: s.reading,
      items: [
        item("/", "today", IconSun, locale),
        item("/archive", "archive", IconHistory, locale),
        item("/chat", "chat", IconMessage, locale),
        item("/settings", "settings", IconUsers, locale),
      ],
    },
    {
      title: s.more,
      items: [
        item("/about", "about", IconHeart, locale),
        item("/feedback", "feedback", IconDoc, locale),
      ],
    },
  ];
}

/** Mobile tab bar items in the given locale. */
export function localizedTabbar(locale: UiLocale = "zh-CN"): LocalizedNavItem[] {
  return [
    item("/", "today", IconSun, locale),
    item("/chat", "chat", IconMessage, locale),
    item("/settings", "settings", IconUsers, locale),
  ];
}

export const SIDEBAR: Array<{ title: string; items: NavItem[] }> = localizedSidebar("zh-CN");
export const TABBAR: NavItem[] = localizedTabbar("zh-CN");
