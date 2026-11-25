import { titled } from "./lib/seo";
import { SITE } from "@topka/industry/site";
import {
  isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, useNavigation, useRouteError, useRouteLoaderData,
  type ShouldRevalidateFunction,
} from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/root";
import "./app.css";
import { ReaderShell } from "./components/shell/ReaderShell";
import { NavigationProgress } from "./components/shell/Chrome";
import { RingMark } from "./components/Logo";
import { buttonClass } from "./components/ui/Controls";
import { THEME_BOOT_SCRIPT } from "./lib/local-state";
import { readerSessionCookie } from "./lib/reader.server";
import { apiGet } from "./lib/api.server";
import { chromeStrings, LocaleProvider, normalizeTimeZone, normalizeUiLocale, type UiLocale } from "./lib/i18n";
import { useHydratedFlag } from "./lib/hydration";

/** The site's language: SITE_LOCALE when set (server), else the industry pack's SITE.locale. */
function siteLocale(): UiLocale {
  const env = typeof process !== "undefined" ? process.env.SITE_LOCALE : undefined;
  return normalizeUiLocale(env || SITE.locale);
}

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "icon", type: "image/png", href: "/icon.png" },
  { rel: "apple-touch-icon", href: "/apple-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
];

interface SiteMeta {
  locale: UiLocale;
  timeZone: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  // Signed-out visitors and the admin see the site's language (SITE_LOCALE, default the industry
  // pack's SITE.locale); a signed-in reader sees their own (Settings → language).
  let locale: UiLocale = siteLocale();
  let timeZone = normalizeTimeZone(null);
  // Reader locale: only fetch /api/auth/me when the reader session cookie is present,
  // and forward ONLY that cookie (admin_session / topka_vid must never reach the api
  // from SSR — cookies do not personalize public results).
  const sessionCookie = readerSessionCookie(request.headers?.get?.("cookie") ?? "");
  if (sessionCookie) {
    try {
      const body = await apiGet<{ user?: { locale?: unknown; timezone?: unknown } }>("/api/auth/me", {
        signal: request.signal,
        headers: { cookie: sessionCookie, "user-agent": request.headers?.get?.("user-agent") ?? "" },
      });
      if (body.user) {
        locale = normalizeUiLocale(body.user.locale);
        timeZone = normalizeTimeZone(body.user.timezone);
      }
    } catch {
      // fall back to SITE.locale
    }
  }
  return { locale, timeZone } satisfies SiteMeta;
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export function Layout({ children }: { children: React.ReactNode }) {
  // html lang follows the page's locale (the reader's, or the site's for visitors and the admin).
  const data = useRouteLoaderData<typeof loader>("root");
  return (
    <html lang={data?.locale ?? siteLocale()} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f2ec" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#171513" />
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
export function meta({ error, loaderData }: Route.MetaArgs) {
  if (!error) return [];
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const strings = chromeStrings(normalizeUiLocale(loaderData?.locale ?? siteLocale()));
  return [{ title: titled(notFound ? strings.notFoundMeta : strings.loadErrorMeta) }, { name: "robots", content: "noindex" }];
}

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  const navigation = useNavigation();
  const strings = chromeStrings(locale);
  return (
    <ReaderShell
      locale={locale}
      before={
        <>
          <NavigationProgress active={navigation.state === "loading"} />
          <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
            {strings.skipToMain}
          </a>
        </>
      }
    >
      {children}
    </ReaderShell>
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
  const page = pathname === "/admin" || pathname.startsWith("/admin/") ? <Outlet /> : (
    <SiteShell locale={locale}>
      <Outlet />
    </SiteShell>
  );
  return <LocaleProvider locale={locale} timeZone={meta.timeZone}>{page}</LocaleProvider>;
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
  const page = pathname === "/admin" || pathname.startsWith("/admin/") ? body
    : <SiteShell locale={locale}>{body}</SiteShell>;
  return <LocaleProvider locale={locale} timeZone={(site as { timeZone?: string } | undefined)?.timeZone}>{page}</LocaleProvider>;
}
