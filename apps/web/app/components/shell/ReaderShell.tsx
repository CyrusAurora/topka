import type { ReactNode } from "react";
import type { UiLocale } from "../../lib/i18n";
import { Sidebar } from "./Sidebar";
import { MobileTabBar } from "./MobileTabBar";
import { BackToTop } from "./Chrome";

/**
 * The reader's frame, shared by the site and the online demo: the sidebar (desktop), one main column,
 * the tab bar (phones). `top` sits above the page inside the column (the demo's line). The tab bar is
 * the last thing in the page's flow and sticks to the bottom of the screen, so it never covers the
 * end of a page.
 */
export function ReaderShell({ locale, top, before, children }: { locale: UiLocale; top?: ReactNode; before?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg lg:flex-row">
      {before}
      <Sidebar locale={locale} />
      <main id="main" className="min-w-0 flex-1 px-5 lg:px-12">
        <div className="mx-auto w-full max-w-[var(--page-max-wide)]">
          {top}
          {children}
        </div>
      </main>
      <MobileTabBar locale={locale} />
      <BackToTop locale={locale} />
    </div>
  );
}
