// Which nav item is the current page, as a plain function: the sidebar and the phone tab bar share it,
// and the tests can check it without loading the icon components (JSX is not loadable under node --test).

export interface NavTarget {
  to: string;
  /** Match the path exactly (the home page). */
  end?: boolean;
}

/** Pages under 设置 on the phone (reached from its links) keep that tab highlighted. */
export const SETTINGS_PATHS = ["/settings", "/about", "/feedback", "/terms", "/privacy", "/projects"];

export function tabIsActive(item: NavTarget, pathname: string): boolean {
  if (item.end) return pathname === item.to;
  // 往期 owns the archive list and one past issue; 今日 is the home page and its per-project views.
  if (item.to === "/archive") return pathname === "/archive" || pathname.startsWith("/archive/") || pathname.startsWith("/issue/");
  if (item.to === "/") return pathname === "/" || pathname === "/today" || pathname.startsWith("/today/");
  if (item.to === "/settings") return SETTINGS_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
