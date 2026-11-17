// The /discover page (master design 2.2: 发现渠道 — 目录线索、待证信号列表、晋升记录; 2.3: 20 条上限、
// 确定性排序、晋升谱系、无效 URL 的线索保留可见但永不晋升). Reads /api/discover with the visitor's
// session: the directory catalog (which feeds are read now and how their last read went), the pending
// list (directory signals plus the reader's own projects' signals, folded, newest first, at most 20)
// and the promotion lineage. Leads are added on each project page. A plain .ts factory for the node
// --test component tests; the route file is a thin shell around it.
import { createElement, useEffect, useState, type FC, type ReactElement } from "react";
import { textLang, useT, useUiPrefs } from "../../lib/i18n.ts";
import { shortTime } from "../today/today-view.ts";
import { isPending, promotionRow, signalRow, type PendingView, type PromotionItem } from "./signals.ts";

export interface CatalogFeed {
  id: string;
  name: string;
  feedUrl: string | null;
  active: boolean;
  lastRead: { at: string; ok: boolean; found: number; error: string | null } | null;
}

export interface DiscoverView {
  catalog: { feedCount: number; enabled: boolean; lastRunAt: string | null; total: number; feeds: CatalogFeed[] };
  pending: PendingView;
  promoted: PromotionItem[];
  projects: Array<{ id: string; slug: string; target: string }>;
}

export interface DiscoverPageProps {
  fetchImpl?: typeof fetch;
}

/** At most this many catalog feeds are listed (the active ones first). */
export const CATALOG_LISTED = 12;

export const DiscoverPage: FC<DiscoverPageProps> = (props) => {
  const t = useT().discover;
  const { locale, timeZone } = useUiPrefs();
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const [state, setState] = useState<{ phase: "loading" | "ready" | "signed-out" | "failed"; view: DiscoverView | null }>({ phase: "loading", view: null });
  const when = (iso: string) => shortTime(iso, locale, timeZone);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await doFetch("/api/discover");
        if (!alive) return;
        if (res.status === 401) return setState({ phase: "signed-out", view: null });
        const body = res.ok ? ((await res.json().catch(() => null)) as DiscoverView | null) : null;
        if (!body || !isPending(body.pending) || !body.catalog || !Array.isArray(body.catalog.feeds)) return setState({ phase: "failed", view: null });
        setState({ phase: "ready", view: { ...body, promoted: Array.isArray(body.promoted) ? body.promoted : [], projects: Array.isArray(body.projects) ? body.projects : [] } });
      } catch {
        if (alive) setState({ phase: "failed", view: null });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const h2 = (text: string) => createElement("h2", { className: "text-[15px] font-semibold text-ink" }, text);
  let body: ReactElement;
  if (state.phase === "loading") body = createElement("p", { role: "status", className: "text-[14px] text-ink-3" }, t.loading);
  else if (state.phase === "signed-out") {
    body = createElement("div", null,
      createElement("p", { role: "status", className: "text-[14px] text-ink-2" }, t.signedOut),
      createElement("a", { href: "/login", className: "mt-4 inline-flex h-11 items-center rounded-full border border-line-strong bg-surface px-5 text-[14px] font-medium text-ink-2" }, t.signIn));
  } else if (state.phase === "failed" || !state.view) body = createElement("p", { role: "alert", className: "text-[14px] text-hot" }, t.loadFailed);
  else {
    const v = state.view;
    const active = v.catalog.feeds.filter((f) => f.active);
    const listed = [...active, ...v.catalog.feeds.filter((f) => !f.active)].slice(0, CATALOG_LISTED);
    body = createElement("div", { className: "flex flex-col gap-8" },
      createElement("section", { "data-catalog": "" },
        h2(t.catalogTitle),
        createElement("p", { className: "mt-1 text-[12.5px] text-ink-3" }, v.catalog.enabled ? t.catalogLine(active.length, v.catalog.total) : t.catalogOff),
        createElement("p", { className: "text-[12px] text-ink-4" }, v.catalog.lastRunAt ? t.catalogLastRun(when(v.catalog.lastRunAt)) : t.catalogNever),
        createElement("ul", { className: "mt-2 flex flex-col gap-1" }, listed.map((f) =>
          createElement("li", { key: f.id, className: "flex items-baseline justify-between gap-3 text-[13px]", "data-feed": f.id },
            createElement("span", { className: f.active ? "text-ink-2" : "text-ink-4" }, f.name),
            createElement("span", { className: `shrink-0 text-[11.5px] ${f.lastRead && !f.lastRead.ok ? "text-hot" : "text-ink-4"}` },
              !f.active ? t.feedIdle : f.lastRead && !f.lastRead.ok ? t.feedFailed : f.lastRead ? `${t.feedActive} · ${t.feedFound(f.lastRead.found)}` : t.feedActive)),
        )),
      ),
      createElement("section", { "data-pending": "" },
        h2(t.pendingTitle),
        createElement("p", { className: "mt-1 text-[12px] text-ink-4" }, t.pendingCount(v.pending.items.length, v.pending.total)),
        v.pending.items.length
          ? createElement("ul", { className: "mt-2 flex flex-col gap-2" }, v.pending.items.map((s) => signalRow(s, t, when)))
          : createElement("p", { className: "mt-2 text-[13.5px] text-ink-3" }, t.awaitingEmpty),
        v.pending.hidden > 0 ? createElement("p", { className: "mt-2 text-[12px] text-ink-4" }, t.hidden(v.pending.hidden, v.pending.cap)) : null,
      ),
      createElement("section", { "data-promoted": "" },
        h2(t.promotedTitle),
        v.promoted.length
          ? createElement("ul", { className: "mt-2 flex flex-col gap-1.5" }, v.promoted.map((p) => promotionRow(p, t)))
          : createElement("p", { className: "mt-2 text-[13.5px] text-ink-3" }, t.promotedEmpty),
      ),
      createElement("section", { "data-projects": "" },
        h2(t.yourProjects),
        v.projects.length
          ? createElement("ul", { className: "mt-2 flex flex-col gap-1" }, v.projects.map((p) =>
            createElement("li", { key: p.id, className: "text-[13.5px]" },
              createElement("a", { href: `/today/${encodeURIComponent(p.slug || p.id)}#signals`, className: "text-ink-2 underline", lang: textLang(p.target, locale) }, p.target))))
          : createElement("p", { className: "mt-2 text-[13.5px] text-ink-3" }, t.noProjects),
      ),
    );
  }
  return createElement("div", { className: "mx-auto w-full max-w-[640px] px-4 py-10" },
    createElement("h1", { className: "text-[18px] font-semibold text-ink" }, t.pageTitle),
    createElement("p", { className: "mt-1 text-[13px] leading-relaxed text-ink-3" }, t.pageIntro),
    createElement("div", { className: "card mt-6 p-6" }, body),
  );
};
