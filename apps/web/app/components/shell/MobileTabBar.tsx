import { Link, useLocation } from "react-router";
import { chromeStrings, normalizeUiLocale, type UiLocale } from "../../lib/i18n";
import { localizedTabbar, tabIsActive } from "./nav";

/** Bottom tab bar of the mobile shell (up to 960px), as on the original site. */
export function MobileTabBar({ locale = "zh-CN" }: { locale?: UiLocale }) {
  const { pathname } = useLocation();
  const loc = normalizeUiLocale(locale);
  const strings = chromeStrings(loc);
  return (
    <nav aria-label={strings.bottomNav} className="sticky bottom-0 z-40 border-t border-line bg-bg/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
      <div className="mx-auto grid h-[56px] max-w-[640px] grid-cols-4">
        {localizedTabbar(loc).map((t) => {
          const active = tabIsActive(t, pathname);
          const Icon = t.icon;
          return (
            <Link
              key={t.to}
              to={t.to}
              prefetch="intent"
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-[3px] text-[11px] transition-colors ${active ? "font-semibold text-ink [&_svg]:text-accent" : "text-ink-3 active:text-ink"}`}
            >
              <Icon size={22} />
              <span>{t.localizedLabel}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
