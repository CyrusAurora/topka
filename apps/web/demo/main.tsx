// The online demo (GitHub Pages): the reader pages of apps/web, with no server. demo-api.ts answers
// /api/* in the browser; the bar on top says what is real and what is the demo model.
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet, RouterProvider, useParams, useSearchParams } from "react-router";
import "./demo.css";
import { Sidebar } from "../app/components/shell/Sidebar";
import { MobileTabBar } from "../app/components/shell/MobileTabBar";
import { BackToTop } from "../app/components/shell/Chrome";
import { THEME_BOOT_SCRIPT } from "../app/lib/local-state";
import { LocaleProvider, normalizeTimeZone, type UiLocale } from "../app/lib/i18n";
import { MagazineToday } from "../app/features/magazine/today";
import { ArchivePage } from "../app/features/magazine/archive";
import { MagazineIssue } from "../app/features/magazine/issue-view";
import { ChatPage } from "../app/features/chat/chat";
import { SettingsPage } from "../app/features/settings/settings";
import { ProjectsOverview } from "../app/features/projects/overview";
import { GuidedCreation } from "../app/features/projects/guided-creation";
import { TodayPage } from "../app/features/today/today-view";
import { createDemoApi, installDemoFetch, SELF_HOST_URL, type DemoPack, type DemoPrefs } from "./demo-api";
import { DEMO_STRINGS, DEMO_ZONES, staleDays } from "./demo-strings";
import { rebaseLinks } from "./links";

const BASE = import.meta.env.BASE_URL; // "/topka/" on Pages, "/" locally
const REPO_URL = "https://github.com/CyrusAurora/topka";
const PREFS_KEY = "topka-demo:prefs";

// eslint-disable-next-line no-new-func
new Function(THEME_BOOT_SCRIPT)();

function loadPrefs(): DemoPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<DemoPrefs> | null;
    const urlLang = new URLSearchParams(location.search).get("lang");
    const locale: UiLocale = urlLang === "en" || urlLang === "zh-CN" ? urlLang : saved?.locale ?? (navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
    return { locale, timeZone: normalizeTimeZone(saved?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) };
  } catch {
    return { locale: "en", timeZone: "UTC" };
  }
}
let prefs = loadPrefs();
const listeners = new Set<() => void>();
function setPrefs(p: Partial<DemoPrefs>) {
  prefs = { ...prefs, ...p, timeZone: normalizeTimeZone(p.timeZone ?? prefs.timeZone) };
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  listeners.forEach((l) => l());
}
function usePrefs(): DemoPrefs {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return prefs;
}

// The shipped project packs, for the wizard and the demo model's source picks.
const packFiles = import.meta.glob("../../../database/seeds/packs/*.json", { eager: true, import: "default" }) as Record<string, { id: string; packId?: string; label?: string; labelEn?: string; sources: Array<{ id: string; name: string; publisher?: string; regions?: string[] }> }>;
const PACKS: DemoPack[] = Object.values(packFiles).map((p) => ({
  id: p.packId ?? p.id, label: p.label ?? p.id, labelEn: p.labelEn ?? null,
  sources: p.sources.map((s) => ({ id: s.id, name: s.name, publisher: s.publisher ?? null, regions: s.regions ?? ["global"] })),
}));

const dataCache = new Map<string, Promise<unknown | null>>();
function data(path: string): Promise<unknown | null> {
  if (!dataCache.has(path)) {
    dataCache.set(path, fetch(`${BASE}data/${path}`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return dataCache.get(path)!;
}

installDemoFetch(createDemoApi({ data, store: { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) }, prefs: () => prefs, setPrefs, packs: PACKS }));

function DemoBar() {
  const p = usePrefs();
  const s = DEMO_STRINGS[p.locale];
  const [meta, setMeta] = useState<{ updatedAt?: string; latestIssueDate?: string | null; issueTimeZone?: string } | null | undefined>(undefined);
  useEffect(() => void data("meta.json").then((m) => setMeta(m as typeof meta)), []);
  const when = meta?.updatedAt
    ? `${new Intl.DateTimeFormat(p.locale, { dateStyle: "medium", timeStyle: "short", timeZone: p.timeZone }).format(new Date(meta.updatedAt))} (${p.timeZone})`
    : "";
  const stale = staleDays(meta?.updatedAt, Date.now());
  const zones = DEMO_ZONES.includes(p.timeZone) ? DEMO_ZONES : [p.timeZone, ...DEMO_ZONES];
  return (
    <div className="demo-bar" role="note" data-demo-bar="">
      <div className="demo-bar-row">
        <span className="demo-badge">{s.badge}</span>
        <span className="demo-lead">{s.lead}</span>
      </div>
      <div className="demo-bar-row demo-small">
        {meta === null ? <span>{s.noData}</span> : null}
        {meta?.updatedAt ? <span data-demo-updated={meta.updatedAt}>{s.updated(when)}</span> : null}
        {meta?.latestIssueDate ? <span data-demo-latest={meta.latestIssueDate}>{s.latest(meta.latestIssueDate)}</span> : null}
        {stale >= 2 ? <span className="demo-stale" data-demo-stale={stale}>{s.stale(stale)}</span> : null}
        <span className="demo-links">
          <a href={SELF_HOST_URL} target="_blank" rel="noopener noreferrer" data-demo-selfhost="">{s.selfHost}</a>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">{s.source}</a>
        </span>
        <label className="demo-select">
          <span>{s.language}</span>
          <select value={p.locale} onChange={(e) => setPrefs({ locale: e.target.value as UiLocale })} data-demo-locale="">
            <option value="en">English</option>
            <option value="zh-CN" lang="zh-CN">中文</option>
          </select>
        </label>
        <label className="demo-select">
          <span>{s.timeZone}</span>
          <select value={p.timeZone} onChange={(e) => setPrefs({ timeZone: e.target.value })} data-demo-zone="">
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

function Shell() {
  const p = usePrefs();
  useEffect(() => {
    document.documentElement.lang = p.locale;
  }, [p.locale]);
  useEffect(() => rebaseLinks(document.body, BASE, (to) => router.navigate(to)), []);
  return (
    <LocaleProvider locale={p.locale} timeZone={p.timeZone}>
      <div className="flex min-h-dvh">
        <Sidebar changelogVersion={null} locale={p.locale} />
        <main id="main" className="min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] lg:px-7 lg:pb-[72px] lg:pt-6">
          <div className="mx-auto w-full max-w-[640px] px-4 lg:max-w-[var(--page-max-wide)] lg:px-0">
            <DemoBar />
            {/* A new key per language and zone: every page loads again in the new setting. */}
            <div key={`${p.locale}|${p.timeZone}`}><Outlet /></div>
          </div>
        </main>
        <MobileTabBar changelogVersion={null} locale={p.locale} />
        <BackToTop locale={p.locale} />
      </div>
    </LocaleProvider>
  );
}

function Info({ title, body }: { title: string; body?: ReactNode }) {
  const s = DEMO_STRINGS[usePrefs().locale];
  return (
    <div className="magazine mx-auto w-full max-w-[560px] px-4 py-16">
      <div className="mag-empty" data-demo-info="">
        <div className="e-t">{title}</div>
        {body ? <div className="e-s">{body}</div> : null}
        <a className="e-cta" href={SELF_HOST_URL} target="_blank" rel="noopener noreferrer">{s.selfHost}</a>
        <a className="e-cta mt-2" href="/">{s.home}</a>
      </div>
    </div>
  );
}
function ServerOnly() {
  const s = DEMO_STRINGS[usePrefs().locale];
  return <Info title={s.infoTitle} body={s.infoBody} />;
}
function NotFound() {
  return <Info title={DEMO_STRINGS[usePrefs().locale].notFound} />;
}
function IssueRoute() {
  const date = useParams().date ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? <MagazineIssue date={date} /> : <NotFound />;
}
function ChatRoute() {
  const [q] = useSearchParams();
  return <ChatPage initialText={q.get("prefill") ?? undefined} />;
}
function ProjectToday() {
  return <TodayPage projectId={useParams().projectId ?? ""} />;
}

const router = createBrowserRouter([
  {
    path: "/",
    Component: Shell,
    children: [
      { index: true, Component: MagazineToday },
      { path: "today", Component: MagazineToday },
      { path: "archive", Component: ArchivePage },
      { path: "issue/:date", Component: IssueRoute },
      { path: "chat", Component: ChatRoute },
      { path: "settings", Component: () => <SettingsPage onDeleted={() => router.navigate("/")} onPrefsChanged={() => undefined} /> },
      { path: "projects", Component: ProjectsOverview },
      { path: "projects/new", Component: GuidedCreation },
      { path: "today/:projectId", Component: ProjectToday },
      ...["about", "feedback", "login", "register", "privacy", "terms"].map((path) => ({ path, Component: ServerOnly })),
      { path: "*", Component: NotFound },
    ],
  },
], { basename: BASE.replace(/\/$/, "") || "/" });

createRoot(document.getElementById("root")!).render(<StrictMode><RouterProvider router={router} /></StrictMode>);
