import { SITE } from "@topka/industry/site";
import { Link, useLocation } from "react-router";
import { Wordmark } from "../Logo";
import { chromeStrings, normalizeUiLocale, type UiLocale } from "../../lib/i18n";
import { localizedSidebar, tabIsActive, type NavItem } from "./nav";
import { ThemeSwitch } from "./ThemeSwitch";

function SideLink({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const isActive = tabIsActive(item, pathname, false);
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      prefetch="intent"
      aria-current={isActive ? "page" : undefined}
      className={`relative flex h-10 items-center gap-3 px-3 text-[15px] transition-colors duration-150 ${
        isActive ? "font-semibold text-ink before:absolute before:inset-y-2.5 before:left-0 before:w-[2px] before:rounded-full before:bg-accent" : "text-ink-3 hover:text-ink"
      }`}
    >
      <span className={`flex w-[20px] shrink-0 justify-center ${isActive ? "text-accent" : ""}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0 truncate">{item.label}</span>
    </Link>
  );
}

export function Sidebar({ locale = "zh-CN" }: { locale?: UiLocale }) {
  const loc = normalizeUiLocale(locale);
  const strings = chromeStrings(loc);
  const sections = localizedSidebar(loc);
  return (
    // The column (paper and rule) runs the full height of the page; the links inside stay in view.
    <aside className="hidden w-[208px] shrink-0 border-r border-line bg-sidebar lg:block">
      <div className="sticky top-0 flex h-dvh flex-col px-4 pb-4 pt-8">
      <Link to="/" className="mb-6 flex h-[40px] items-center px-3 text-ink" aria-label={strings.home(SITE.name)}>
        <Wordmark size={22} />
      </Link>
      <nav className="-mx-1 flex-1 overflow-y-auto px-1" aria-label={strings.mainNav}>
        {sections.map((section) => (
          <div key={section.title}>
            <div className="px-3 pb-1.5 pt-5 text-[12px] tracking-[0.12em] text-ink-3">{section.title}</div>
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <SideLink key={item.to} item={item} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="mt-2 space-y-2.5 px-1 pt-1">
        <ThemeSwitch className="mx-1" locale={loc} />
        {SITE.icp && (
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="block px-2 text-[10px] text-ink-4 hover:text-ink-3">
            {SITE.icp}
          </a>
        )}
      </div>
      </div>
    </aside>
  );
}
