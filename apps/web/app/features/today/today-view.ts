// The per-project today reading view (master design J4, first simple form): the items that entered
// the project's sources since the last confirmed read: a fixed few cards, most important for the project first, or the first-class
// "无重要变化" result. "看完了" moves the server-side checkpoint to the window the reader saw. Reads
// /api/projects/:id/today with the visitor's session; a plain .ts factory for the node --test
// component tests, the route file is a thin shell around it.
import { createElement, useCallback, useEffect, useState, type FC, type ReactElement } from "react";
import { intlLocale, useT, useUiPrefs, type UiLocale } from "../../lib/i18n.ts";
import { zh } from "../../lib/locales/today.ts";

export interface TodayItemView {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  url: string;
  source: { id: string; name: string };
  publishedAt: string | null;
  listedAt: string;
  selected: boolean;
  score?: number | null;
}

export interface TodayView {
  project: { id: string; slug: string; target: string; purpose: string };
  window: { since: string; until: string };
  checkpoint: { readThrough: string | null };
  sources: { linked: number; active: number };
  result: "updates-available" | "no-important-change";
  emptyState: { title: string; detail: string } | null;
  items: TodayItemView[];
  /** Fixed daily card count (TODAY_CARD_COUNT, 3–5); the rest is not listed. */
  cardCount: number;
  /** The cards' mean project score is below 50 (not shown yet; the UI may say the day was quiet). */
  quietDay: boolean;
  awaitingAnalysis: number;
  notice: string;
}

export const TODAY_LOADING = zh.loading;
export const TODAY_SIGNED_OUT = zh.signedOut;
export const TODAY_NOT_FOUND = zh.notFound;
export const TODAY_FAILED = zh.failed;
export const ACK_LABEL = zh.ack;
export const ACK_DONE = zh.ackDone;
export const ACK_FINE_PRINT = zh.ackFinePrint;

export const shortTime = (iso: string | null, locale: UiLocale = "zh-CN", timeZone: string = "Asia/Shanghai") => {
  if (!iso) return "";
  const options: Intl.DateTimeFormatOptions = locale === "en"
    ? { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }
    : { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  return new Intl.DateTimeFormat(intlLocale(locale), options).format(new Date(iso));
};

export interface TodayPageProps {
  projectId: string;
  fetchImpl?: typeof fetch;
}

type Phase = "loading" | "ready" | "signed-out" | "not-found" | "failed";

export const TodayPage: FC<TodayPageProps> = (props) => {
  const t = useT();
  const { locale, timeZone } = useUiPrefs();
  // The API's fixed copy (empty state, notice) is Chinese: an English page shows its own.
  const zhOr = (server: string | null | undefined, own: string) => (locale === "zh-CN" && server ? server : own);
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const path = `/api/projects/${encodeURIComponent(props.projectId)}/today`;
  const [state, setState] = useState<{ phase: Phase; view: TodayView | null }>({ phase: "loading", view: null });
  const [ack, setAck] = useState<"idle" | "sending" | "done" | "failed">("idle");

  const load = useCallback(async () => {
    try {
      const res = await doFetch(path);
      if (res.status === 401) return setState({ phase: "signed-out", view: null });
      if (res.status === 404) {
        // Signed out and not-found read the same on the API (existence is never leaked); ask once.
        const me = await doFetch("/api/auth/me").catch(() => null);
        return setState({ phase: me && me.status === 200 ? "not-found" : "signed-out", view: null });
      }
      if (!res.ok) return setState({ phase: "failed", view: null });
      setState({ phase: "ready", view: (await res.json()) as TodayView });
    } catch {
      setState({ phase: "failed", view: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const acknowledge = async () => {
    if (!state.view) return;
    setAck("sending");
    try {
      const res = await doFetch(`${path}/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ through: state.view.window.until }) });
      setAck(res.ok ? "done" : "failed");
    } catch {
      setAck("failed");
    }
  };

  let body: ReactElement;
  const v = state.view;
  if (state.phase === "loading") body = createElement("p", { role: "status", className: "text-[14px] text-ink-3" }, t.today.loading);
  else if (state.phase === "signed-out")
    body = createElement("div", null,
      createElement("p", { role: "status", className: "text-[14px] text-ink-2" }, t.today.signedOut),
      createElement("a", { href: "/login", className: "mt-4 inline-flex h-11 items-center rounded-full border border-line-strong bg-surface px-5 text-[14px] font-medium text-ink-2" }, t.today.goSignIn),
    );
  else if (state.phase === "not-found") body = createElement("p", { role: "status", className: "text-[14px] text-ink-2" }, t.today.notFound);
  else if (state.phase === "failed" || !v) body = createElement("p", { role: "alert", className: "text-[14px] text-hot" }, t.today.failed);
  else {
    const list = v.result === "no-important-change"
      ? createElement("section", { role: "status", "aria-label": zhOr(v.emptyState?.title, t.today.noImportantChange), className: "rounded-2xl border border-line bg-surface px-4 py-6 text-center" },
          createElement("div", { className: "text-[16px] font-semibold text-ink" }, zhOr(v.emptyState?.title, t.today.noImportantChange)),
          createElement("p", { className: "mt-2 text-[13.5px] leading-relaxed text-ink-3" }, zhOr(v.emptyState?.detail, t.today.noChangeDetail)),
        )
      : createElement("ol", { className: "flex flex-col gap-3" },
          v.items.map((item, i) =>
            createElement("li", { key: item.id, className: "rounded-2xl border border-line bg-surface px-4 py-3" },
              createElement("div", { className: "text-[12px] text-ink-4" }, `${i + 1} / ${v.items.length}${item.selected ? t.today.selectedSuffix : ""}`),
              createElement("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", className: "mt-1 block text-[15.5px] font-medium leading-snug text-ink" }, item.title),
              item.originalTitle ? createElement("div", { className: "mt-0.5 text-[12.5px] text-ink-4" }, item.originalTitle) : null,
              item.summary
                ? createElement("p", { className: "mt-2 text-[13.5px] leading-relaxed text-ink-2" },
                    createElement("span", { className: "mr-1 rounded bg-surface-2 px-1 text-[11px] text-ink-4" }, t.today.analysisBadge), item.summary)
                : null,
              createElement("div", { className: "mt-2 flex flex-wrap gap-x-2 text-[12px] text-ink-4" },
                createElement("span", null, item.source.name),
                createElement("span", null, shortTime(item.publishedAt ?? item.listedAt, locale, timeZone)),
                createElement("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", className: "underline" }, t.today.viewOriginal),
              ),
            ),
          ),
        );
    body = createElement("div", null,
      list,
      v.awaitingAnalysis > 0 ? createElement("p", { className: "mt-3 text-[12.5px] text-ink-4" }, t.today.awaitingAnalysis(v.awaitingAnalysis)) : null,
      createElement("div", { className: "mt-6 flex flex-col items-start gap-1" },
        createElement("button", { type: "button", onClick: acknowledge, disabled: ack === "sending" || ack === "done", className: "inline-flex h-11 min-w-[44px] items-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-contrast disabled:opacity-60" }, t.today.ack),
        createElement("p", { className: "text-[11.5px] text-ink-4" }, t.today.ackFinePrint),
        ack === "done" ? createElement("p", { role: "status", className: "text-[12.5px] text-ink-3" }, t.today.ackDone) : null,
        ack === "failed" ? createElement("p", { role: "alert", className: "text-[12.5px] text-hot" }, t.today.ackFailed) : null,
      ),
      createElement("p", { className: "mt-6 text-[11.5px] leading-relaxed text-ink-4" }, zhOr(v.notice, t.today.notice)),
    );
  }

  return createElement("div", { className: "mx-auto w-full max-w-[560px] px-4 py-6 sm:py-10" },
    createElement("div", { className: "text-[12px] text-ink-4" }, t.today.title),
    createElement("h1", { className: "text-[18px] font-semibold text-ink" }, v?.project.target ?? t.today.projectFallback),
    v ? createElement("p", { className: "mt-0.5 text-[13px] text-ink-3" }, t.today.sourcesLine(v.project.purpose, v.sources.active, shortTime(v.window.since, locale, timeZone))) : null,
    createElement("div", { className: "mt-5" }, body),
  );
};
