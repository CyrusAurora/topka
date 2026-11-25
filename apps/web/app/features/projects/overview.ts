// The project overview (master design 2.1/2.2, construction step 3): the caller's projects as name
// plus summary, the first-project empty state, and an honest signed-out state. Reads /api/projects
// with the visitor's session; the component is a plain .ts factory for the node --test component
// tests, and the route file is a thin shell around it.
import { createElement, type FC, type ReactElement } from "react";
import { useReaderGet } from "../../lib/reader-data.ts";
import { skeletonRows } from "../magazine/states.ts";
import { textLang, useLocale, useT } from "../../lib/i18n.ts";
import { zh } from "../../lib/locales/projects.ts";

export interface ProjectListItem {
  id: string;
  /** Short handle for links (/projects/:slug); older API answers may lack it. */
  slug?: string;
  target: string;
  purpose: string;
  status: string;
  currentRevision: number;
}

/** A project's own page. */
export function projectHref(project: { id: string; slug?: string | null }): string {
  return `/projects/${encodeURIComponent(project.slug || project.id)}`;
}

export const OVERVIEW_EMPTY = zh.overview.empty;
export const CREATE_FIRST = zh.overview.createFirst;

/** The page's one GET. */
export const PROJECTS_PATH = "/api/projects";

export interface ProjectsOverviewProps {
  fetchImpl?: typeof fetch;
}

export const ProjectsOverview: FC<ProjectsOverviewProps> = (props) => {
  const t = useT().projects.overview;
  const locale = useLocale();
  const got = useReaderGet<{ projects?: ProjectListItem[] }>(PROJECTS_PATH, props.fetchImpl);
  const state = { phase: got.phase, projects: Array.isArray(got.body?.projects) ? got.body.projects : [] };

  let body: ReactElement;
  if (state.phase === "loading") {
    body = skeletonRows(t.loading);
  } else if (state.phase === "signed-out") {
    body = createElement("div", null,
      createElement("p", { role: "status", className: "text-[14px] text-ink-2" }, t.signedOut),
      createElement("a", { href: "/login", className: "mt-4 inline-flex h-11 items-center rounded-full border border-line-strong bg-surface px-5 text-[14px] font-medium text-ink-2 hover:border-ink-4 hover:text-ink" }, t.signIn),
    );
  } else if (state.phase === "failed") {
    body = createElement("p", { role: "alert", className: "text-[14px] text-hot" }, t.loadFailed);
  } else if (state.projects.length === 0) {
    body = createElement("div", null,
      createElement("p", { className: "pt-6 text-[15px] leading-relaxed text-ink-2" }, t.empty),
      createElement("a", { href: "/projects/new", className: "mt-4 inline-flex h-11 items-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-contrast hover:bg-accent-ink" }, t.createFirst),
    );
  } else {
    body = createElement("ul", { className: "flex flex-col" },
      state.projects.map((project) =>
        createElement("li", { key: project.id, className: "border-b border-line py-4 last:border-b-0" },
          createElement("a", { href: projectHref(project), className: "text-[17px] font-semibold text-ink hover:text-accent", lang: textLang(project.target, locale) }, project.target),
          createElement("div", { className: "mt-1 text-[15px] leading-relaxed text-ink-2", lang: textLang(project.purpose, locale) }, project.purpose),
        ),
      ),
    );
  }

  return createElement("div", { className: "mag-page" },
    createElement("h1", { className: "mag-page-title" }, t.title),
    createElement("div", { className: "mag-rule" }),
    createElement("div", { className: "mt-2" }, body),
  );
}
