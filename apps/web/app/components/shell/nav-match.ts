// Which nav item is the current page, as a plain function: the sidebar and the phone tab bar share it,
// and the tests can check it without loading the icon components (JSX is not loadable under node --test).

export interface NavTarget {
  to: string;
  /** Match the path exactly (the home page). */
  end?: boolean;
}

/** Pages under 设置 on the phone (reached from its links) keep that tab highlighted. */
export const SETTINGS_PATHS = ["/settings", "/about", "/feedback", "/terms", "/privacy", "/projects"];

/**
 * True when `item` is the current page. The phone tab bar has no 关于 / 反馈 tabs, so there 设置 owns
 * those pages (`grouped`); the desktop sidebar lists them itself and highlights exactly one item.
 */
export function tabIsActive(item: NavTarget, pathname: string, grouped = true): boolean {
  if (item.end) return pathname === item.to;
  // 往期 owns the archive list and one past issue; 今日 is the home page.
  if (item.to === "/archive") return pathname === "/archive" || pathname.startsWith("/archive/") || pathname.startsWith("/issue/");
  if (item.to === "/") return pathname === "/" || pathname === "/today";
  if (item.to === "/settings" && !grouped) return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/projects" || pathname.startsWith("/projects/");
  if (item.to === "/settings") return SETTINGS_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
