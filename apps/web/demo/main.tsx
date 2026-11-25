// The online demo (GitHub Pages): the reader pages of apps/web, with no server. demo-api.ts answers
// /api/* in the browser. One line on top names the demo and the two ways out; language and time zone
// live in 设置, as in the real app.
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useParams, useSearchParams } from "react-router";
import "./demo.css";
import { ReaderShell } from "../app/components/shell/ReaderShell";
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
import { DEMO_STRINGS } from "./demo-strings";
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
  const s = DEMO_STRINGS[usePrefs().locale];
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => void data("meta.json").then((m) => setLatest((m as { latestIssueDate?: string | null } | null)?.latestIssueDate ?? null)), []);
  return (
    <div className="demo-bar" data-demo-bar="" data-demo-latest={latest ?? undefined}>
      <span className="demo-badge">{s.badge}</span>
      <span aria-hidden="true">·</span>
      <a href={SELF_HOST_URL} target="_blank" rel="noopener noreferrer" data-demo-selfhost="">{s.selfHost}</a>
      <span aria-hidden="true">·</span>
      <a href={REPO_URL} target="_blank" rel="noopener noreferrer">{s.source}</a>
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
      <ReaderShell locale={p.locale} top={<DemoBar />}>
        {/* A new key per language and zone: every page loads again in the new setting. */}
        <div key={`${p.locale}|${p.timeZone}`}><Outlet /></div>
      </ReaderShell>
    </LocaleProvider>
  );
}

function Info({ title, body }: { title: string; body?: ReactNode }) {
  const s = DEMO_STRINGS[usePrefs().locale];
  return (
    <div className="magazine mag-page mag-page-empty">
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
/** The old address of a project's page. */
function ProjectMoved() {
  return <Navigate replace to={`/projects/${encodeURIComponent(useParams().projectId ?? "")}`} />;
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
      { path: "projects/:projectId", Component: ProjectToday },
      { path: "today/:projectId", Component: ProjectMoved },
      ...["about", "feedback", "login", "register", "privacy", "terms"].map((path) => ({ path, Component: ServerOnly })),
      { path: "*", Component: NotFound },
    ],
  },
], { basename: BASE.replace(/\/$/, "") || "/" });

createRoot(document.getElementById("root")!).render(<StrictMode><RouterProvider router={router} /></StrictMode>);
