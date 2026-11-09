import { titled } from "./lib/seo";
import { SITE } from "@topka/industry/site";
import {
  isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, useNavigation, useRouteError, useRouteLoaderData,
  type ShouldRevalidateFunction,
} from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/root";
import "./app.css";
import { Sidebar } from "./components/shell/Sidebar";
import { MobileTabBar } from "./components/shell/MobileTabBar";
import { BackToTop, NavigationProgress } from "./components/shell/Chrome";
import { RingMark } from "./components/Logo";
import { buttonClass } from "./components/ui/Controls";
import { THEME_BOOT_SCRIPT } from "./lib/local-state";
import { apiGet } from "./lib/api.server";
import { chromeStrings, normalizeUiLocale, type UiLocale } from "./lib/i18n";
import { useHydratedFlag } from "./lib/hydration";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "icon", type: "image/png", href: "/icon.png" },
  { rel: "apple-touch-icon", href: "/apple-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "alternate", type: "application/rss+xml", title: `${SITE.name} — 精选`, href: "/feed.xml" },
];

interface SiteMeta {
  changelogVersion: string | null;
  locale: UiLocale;
}

// Reader session cookie; matches @topka/backend/accounts/session.ts (SESSION_COOKIE).
const READER_SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "topka_session";

function readerSessionCookie(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === READER_SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value ? `${READER_SESSION_COOKIE}=${value}` : null;
    }
  }
  return null;
}

export async function loader({ request }: Route.LoaderArgs) {
  let meta: { changelogVersion: string | null } = { changelogVersion: null };
  let locale: UiLocale = normalizeUiLocale(SITE.locale as string);
  try {
    meta = await apiGet<{ changelogVersion: string | null }>("/api/site/meta", { signal: request.signal });
  } catch {
    meta = { changelogVersion: null };
  }
  // Reader locale: only fetch /api/auth/me when the reader session cookie is present,
  // and forward ONLY that cookie (admin_session / topka_vid must never reach the api
  // from SSR — cookies do not personalize public results).
  const sessionCookie = readerSessionCookie(request.headers?.get?.("cookie") ?? "");
  if (sessionCookie) {
    try {
      const body = await apiGet<{ user?: { locale?: unknown } }>("/api/auth/me", {
        signal: request.signal,
        headers: { cookie: sessionCookie, "user-agent": request.headers?.get?.("user-agent") ?? "" },
      });
      locale = normalizeUiLocale(body.user?.locale);
    } catch {
      // fall back to SITE.locale
    }
  }
  return { changelogVersion: meta.changelogVersion, locale } satisfies SiteMeta;
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export function Layout({ children }: { children: React.ReactNode }) {
  // Per-user locale reaches html lang via client draw: root loader may set documentElement in App.
  return (
    <html lang={SITE.locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf9f6" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#13191c" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration getKey={(location) => location.key} />
        <Scripts />
      </body>
    </html>
  );
}

/** Only a page nobody matched falls back to this; every page names itself. */
export function meta({ error }: Route.MetaArgs) {
  if (!error) return [];
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return [{ title: titled(notFound ? "页面不存在" : "暂时无法加载") }, { name: "robots", content: "noindex" }];
}

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ changelogVersion, locale, children }: { changelogVersion: string | null; locale: UiLocale; children: ReactNode }) {
  const navigation = useNavigation();
  const strings = chromeStrings(locale);
  return (
    <div className="flex min-h-dvh">
      <NavigationProgress active={navigation.state === "loading"} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
        {strings.skipToMain}
      </a>
      <Sidebar changelogVersion={changelogVersion} locale={locale} />
      {/* Mobile shell (≤ 960px): one centred column, the tab bar below. Desktop: the page fills the main area
          up to the list width (--page-max-wide), centred beyond it. */}
      <main id="main" className="min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] lg:px-7 lg:pb-[72px] lg:pt-6">
        <div className="mx-auto w-full max-w-[640px] px-4 lg:max-w-[var(--page-max-wide)] lg:px-0">{children}</div>
      </main>
      <MobileTabBar changelogVersion={changelogVersion} locale={locale} />
      <BackToTop locale={locale} />
    </div>
  );
}

export default function App() {
  const meta = useLoaderData<typeof loader>();
  useHydratedFlag();
  const locale: UiLocale = normalizeUiLocale((meta as unknown as { locale?: unknown })?.locale);
  // html lang should follow the signed-in user; Layout renders first, so stamp it here.
  useEffectLocale(locale);
  const { pathname } = useLocation();
  // The admin has its own chrome.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return <Outlet />;
  return (
    <SiteShell changelogVersion={meta.changelogVersion} locale={locale}>
      <Outlet />
    </SiteShell>
  );
}

function useEffectLocale(locale: UiLocale) {
  // Keep document lang in sync with loader locale (covers the "en" user).
  try {
    document.documentElement.lang = locale;
  } catch {
    // server render has no document
  }
}

export function ErrorBoundary() {
  const error = useRouteError();
  const site = useRouteLoaderData<typeof loader>("root");
  const locale: UiLocale = normalizeUiLocale((site as unknown as { locale?: unknown })?.locale);
  const strings = chromeStrings(locale);
  const { pathname } = useLocation();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const notFound = status === 404;
  const body = (
    <div className="flex min-h-[70vh] items-center justify-center px-2 py-16">
      <div className="max-w-sm text-center">
        <RingMark className="mx-auto mb-5 size-10 text-accent" />
        <div className="mono text-[12px] text-ink-4">{status}</div>
        <h1 className="mt-1.5 text-[20px] font-bold text-ink">{notFound ? strings.notFoundTitle : strings.loadErrorTitle}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
          {notFound ? strings.notFoundBody : strings.loadErrorBody}
        </p>
        <div className="mt-6 flex justify-center gap-2.5">
          <Link to="/" className={buttonClass("primary")}>
            {strings.backToToday}
          </Link>
          <Link to="/archive" className={buttonClass("secondary")}>
            {strings.browseArchive}
          </Link>
        </div>
      </div>
    </div>
  );
  // Admin errors stay inside the admin's own chrome.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return body;
  return <SiteShell changelogVersion={site?.changelogVersion ?? null} locale={locale}>{body}</SiteShell>;
}
