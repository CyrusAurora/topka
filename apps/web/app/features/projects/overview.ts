// The project overview (master design 2.1/2.2, construction step 3): the caller's projects as name
// plus summary, the first-project empty state, and an honest signed-out state. Reads /api/projects
// with the visitor's session; the component is a plain .ts factory for the node --test component
// tests, and the route file is a thin shell around it.
import { createElement, useEffect, useState, type FC, type ReactElement } from "react";
import { useT } from "../../lib/i18n.ts";
import { zh } from "../../lib/locales/projects.ts";

export interface ProjectListItem {
  id: string;
  /** Short handle for links (/today/:slug); older API answers may lack it. */
  slug?: string;
  target: string;
  purpose: string;
  status: string;
  currentRevision: number;
}

export const OVERVIEW_EMPTY = zh.overview.empty;
export const CREATE_FIRST = zh.overview.createFirst;

export interface ProjectsOverviewProps {
  fetchImpl?: typeof fetch;
}

export const ProjectsOverview: FC<ProjectsOverviewProps> = (props) => {
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const t = useT().projects.overview;
  const [state, setState] = useState<{ phase: "loading" | "ready" | "signed-out" | "failed"; projects: ProjectListItem[] }>({
    phase: "loading",
    projects: [],
  });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await doFetch("/api/projects");
        if (!alive) return;
        if (res.status === 401) {
          setState({ phase: "signed-out", projects: [] });
          return;
        }
        if (!res.ok) {
          setState({ phase: "failed", projects: [] });
          return;
        }
        const body = (await res.json()) as { projects?: ProjectListItem[] };
        setState({ phase: "ready", projects: Array.isArray(body.projects) ? body.projects : [] });
      } catch {
        if (alive) setState({ phase: "failed", projects: [] });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let body: ReactElement;
  if (state.phase === "loading") {
    body = createElement("p", { role: "status", className: "text-[14px] text-ink-3" }, t.loading);
  } else if (state.phase === "signed-out") {
    body = createElement("div", null,
      createElement("p", { role: "status", className: "text-[14px] text-ink-2" }, t.signedOut),
      createElement("a", { href: "/login", className: "mt-4 inline-flex h-11 items-center rounded-full border border-line-strong bg-surface px-5 text-[14px] font-medium text-ink-2 hover:border-ink-4 hover:text-ink" }, t.signIn),
    );
  } else if (state.phase === "failed") {
    body = createElement("p", { role: "alert", className: "text-[14px] text-hot" }, t.loadFailed);
  } else if (state.projects.length === 0) {
    body = createElement("div", null,
      createElement("p", { className: "text-[14.5px] leading-relaxed text-ink-2" }, t.empty),
      createElement("a", { href: "/projects/new", className: "mt-4 inline-flex h-11 items-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-contrast hover:bg-accent-ink" }, t.createFirst),
    );
  } else {
    body = createElement("ul", { className: "flex flex-col gap-3" },
      state.projects.map((project) =>
        createElement("li", { key: project.id, className: "rounded-2xl border border-line bg-surface px-4 py-3" },
          createElement("a", { href: `/today/${encodeURIComponent(project.slug ?? project.id)}`, className: "text-[14.5px] font-medium text-ink hover:underline" }, project.target),
          createElement("div", { className: "mt-0.5 text-[13px] leading-relaxed text-ink-3" }, project.purpose),
        ),
      ),
    );
  }

  return createElement("div", { className: "mx-auto w-full max-w-[560px] px-4 py-10" },
    createElement("h1", { className: "text-[17px] font-semibold text-ink" }, t.title),
    createElement("div", { className: "card mt-6 p-6" }, body),
  );
}
