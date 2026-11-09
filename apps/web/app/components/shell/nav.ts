// Site navigation, one place for the desktop sidebar and the mobile tab bar. The product is the
// personal magazine: 今日 (the home page) | 对话 | 设置, with 往期 beside 今日. The old public
// timeline pages redirect (routes/legacy.tsx).
import type { ReactNode } from "react";
import { IconDoc, IconHeart, IconHistory, IconMessage, IconSun, IconUsers } from "../icons";
import type { NavTarget } from "./nav-match";

export { SETTINGS_PATHS, tabIsActive } from "./nav-match";

export interface NavItem extends NavTarget {
  to: string;
  label: string;
  icon: (p: { size?: number }) => ReactNode;
  /** Match the path exactly (the home page). */
  end?: boolean;
  /** Shows the unread dot while the changelog has news. */
  changelog?: boolean;
}

export const SIDEBAR: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "阅读",
    items: [
      { to: "/", label: "今日", icon: IconSun },
      { to: "/archive", label: "往期", icon: IconHistory },
      { to: "/chat", label: "对话", icon: IconMessage },
      { to: "/settings", label: "设置", icon: IconUsers },
    ],
  },
  {
    title: "更多",
    items: [
      { to: "/about", label: "关于", icon: IconHeart },
      { to: "/feedback", label: "反馈", icon: IconDoc },
    ],
  },
];

/** The phone tab bar: the same three doors as the mini program. */
export const TABBAR: NavItem[] = [
  { to: "/", label: "今日", icon: IconSun },
  { to: "/chat", label: "对话", icon: IconMessage },
  { to: "/settings", label: "设置", icon: IconUsers },
];

