// The per-project today reading view (master design J4 and the checkpoint of 3.3): the items that
// entered the project's sources since the last confirmation — a fixed few cards, most important for
// the project first, or the first-class "无重要变化" result. Every load is a stored snapshot with a top
// result from the decision table (@topka/contracts/brief); this page adds the one row only it can see,
// offline or signed out, keeps the last brief readable then, shows why a blocking result cannot be
// confirmed (coverage, unassessed material, a snapshot not saved), and confirms by naming the
// snapshot, its ackSeq, the cards shown and a commandId (kept for retries, so a retry gets the same
// receipt). Corrected observations carry a chip and their earlier versions. Reads
// /api/projects/:id/today with the visitor's session; a plain .ts factory for the node --test
// component tests, the route file is a thin shell around it.
import { createElement, useCallback, useEffect, useRef, useState, type FC, type ReactElement } from "react";
import { phaseOf, usePrefetched, type Responses } from "../../lib/reader-data.ts";
import { acknowledgementAllowed, evaluateBrief, type BriefResult, type CoverageEntry } from "@topka/contracts/brief";
import { intlLocale, messages, textLang, useT, useUiPrefs, type UiLocale } from "../../lib/i18n.ts";
import { MODEL_DOC_URL, SOURCES_DOC_URL } from "../../lib/docs-links.ts";
import { zh } from "../../lib/locales/today.ts";
import { SignalsAwaitingSection } from "../discover/signals.ts";

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
  ledger?: "current" | "corrected";
  /** Channel signals this observation confirmed (promotion lineage). */
  confirmedSignals?: Array<{ channelName: string; url: string; kind: "directory" | "pack" | "user-lead" }>;
}

export interface TodayView {
  project: { id: string; slug: string; target: string; purpose: string };
  window: { since: string; until: string; basis?: "checkpoint" | "default" | "capped" };
  checkpoint: { readThrough: string | null; ackSeq?: number; receiptId?: string | null };
  snapshot?: { id: string | null; ackSeq: number; acknowledgementAllowed: boolean };
  sources: { linked: number; active: number; scheduled?: number; collectionOn?: boolean; analysisOn?: boolean };
  coverage?: { satisfied: boolean; sources: CoverageEntry[] };
  unassessed?: number;
  result: Exclude<BriefResult, "offline-or-auth">;
  emptyState: { title: string; detail: string } | null;
  items: TodayItemView[];
  /** Fixed daily card count (TODAY_CARD_COUNT, 3–5); the rest is not listed. */
  cardCount: number;
  /** The cards' mean project score is below 50 (not shown yet; the UI may say the day was quiet). */
  quietDay: boolean;
  awaitingAnalysis: number;
}

interface History {
  revisions: Array<{ revision: number; title: string; recordedAt: string }>;
  conflicts: Array<{ title: string; excerpt: string | null; reportedAt: string }>;
}

export const ACK_LABEL = zh.ack;
export const ACK_DONE = zh.ackDone;

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

type Phase = "loading" | "ready" | "signed-out" | "offline" | "not-found" | "failed";
type AckState = { kind: "idle" | "sending" | "done" | "failed" | "offline" } | { kind: "refused"; code: string } | { kind: "done"; receiptId: string };

const newCommandId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** The brief's top result as the reader sees it: the server's, unless the page itself is offline or signed out. */
export function readerResult(view: TodayView | null, offlineOrAuth: boolean): BriefResult | null {
  if (offlineOrAuth) return "offline-or-auth";
  if (!view) return null;
  return view.result;
}

/** Whether the reader may confirm what they see: the result allows it and the snapshot was stored. */
export function canConfirm(view: TodayView | null, offlineOrAuth: boolean): boolean {
  const result = readerResult(view, offlineOrAuth);
  return !!view && !!result && acknowledgementAllowed(result) && !!view.snapshot?.id && view.snapshot.acknowledgementAllowed;
}

/** Why a project may stay empty: some of its sources are off, or the site does not collect at all. */
export function sourcesNotice(sources: TodayView["sources"], locale: UiLocale = "zh-CN"): ReactElement | null {
  const t = messages(locale).today;
  const off = Math.max(0, sources.linked - sources.active);
  // Only for sources the worker would fetch: the demo's imported (`external`) sources need neither.
  const fetched = (sources.scheduled ?? 0) > 0 || off > 0;
  const collectionOff = sources.collectionOn === false && fetched;
  const analysisOff = sources.analysisOn === false && fetched;
  if (!off && !collectionOff && !analysisOff) return null;
  const lines = [off ? t.sourcesOff(off, sources.linked) : null, collectionOff ? t.collectionOff : null, analysisOff ? t.analysisOff : null].filter((x): x is string => !!x);
  const link = (href: string, text: string, attr: string) => createElement("a", { href, target: "_blank", rel: "noopener noreferrer", className: "mr-4 mt-1.5 inline-block underline", [attr]: "" }, text);
  return createElement("div", { role: "note", className: "mt-3 rounded-2xl bg-bg-sunk px-4 py-3 text-[12.5px] leading-relaxed text-ink-2", "data-sources-notice": "" },
    ...lines.map((line, i) => createElement("p", { key: i, className: i ? "mt-1.5" : undefined }, line)),
    off || collectionOff ? link(SOURCES_DOC_URL, t.sourcesHowTo, "data-sources-doc") : null,
    analysisOff ? link(MODEL_DOC_URL, t.modelHowTo, "data-model-doc") : null,
  );
}

/** The page's GETs: the project's today, and the account (a 404 reads the same signed out). */
export function projectTodayPaths(projectId: string): string[] {
  return [`/api/projects/${encodeURIComponent(projectId)}/today`, "/api/auth/me"];
}

function projectTodayStateOf(data: Responses, path: string): { phase: Phase; view: TodayView | null } {
  const got = data[path];
  if (got?.status === 404) return { phase: data["/api/auth/me"]?.status === 200 ? "not-found" : "signed-out", view: null };
  const phase = phaseOf(got);
  return phase === "ready" ? { phase, view: got!.body as TodayView } : { phase, view: null };
}

export const TodayPage: FC<TodayPageProps> = (props) => {
  const t = useT();
  const { locale, timeZone } = useUiPrefs();
  // The API's fixed copy (empty state, notice) is Chinese: an English page shows its own.
  const zhOr = (server: string | null | undefined, own: string) => (locale === "zh-CN" && server ? server : own);
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const path = `/api/projects/${encodeURIComponent(props.projectId)}/today`;
  const prefetched = usePrefetched(projectTodayPaths(props.projectId));
  const [state, setState] = useState<{ phase: Phase; view: TodayView | null }>(() => (prefetched ? projectTodayStateOf(prefetched, path) : { phase: "loading", view: null }));
  // The page arrived rendered for this project: the first load is the one the server did.
  const seededFor = useRef(prefetched ? path : "");
  const [ack, setAck] = useState<AckState>({ kind: "idle" });
  const [open, setOpen] = useState<Record<string, History | "loading" | "failed" | undefined>>({});
  const [requiredError, setRequiredError] = useState(false);
  // One commandId per snapshot: a retry of the same confirmation gets the same receipt.
  const command = useRef<{ snapshotId: string | null; id: string }>({ snapshotId: null, id: newCommandId() });

  const load = useCallback(async () => {
    try {
      const res = await doFetch(path);
      if (res.status === 401) return setState((s) => ({ phase: "signed-out", view: s.view }));
      if (res.status === 404) {
        // Signed out and not-found read the same on the API (existence is never leaked); ask once.
        const me = await doFetch("/api/auth/me").catch(() => null);
        return setState({ phase: me && me.status === 200 ? "not-found" : "signed-out", view: null });
      }
      if (!res.ok) return setState({ phase: "failed", view: null });
      setState({ phase: "ready", view: (await res.json()) as TodayView });
      setAck({ kind: "idle" });
    } catch {
      // No network: the brief already loaded stays readable (offline-or-auth, not confirmable).
      setState((s) => ({ phase: "offline", view: s.view }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    if (seededFor.current === path) {
      seededFor.current = "";
      return;
    }
    void load();
  }, [load, path]);
  useEffect(() => {
    const back = () => void load();
    globalThis.addEventListener?.("online", back);
    return () => globalThis.removeEventListener?.("online", back);
  }, [load]);

  const v = state.view;
  const offlineOrAuth = state.phase === "offline" || state.phase === "signed-out";
  const result = evaluateBrief({
    offlineOrAuth,
    snapshotFailed: v?.result === "snapshot-failed",
    coverageSatisfied: v?.result !== "partial-coverage",
    unassessed: v?.result === "abstained-impact" ? Math.max(1, v.unassessed ?? 0) : 0,
    updates: v?.items.length ?? 0,
  });
  const confirmable = canConfirm(v, offlineOrAuth);

  const acknowledge = async () => {
    if (!v?.snapshot?.id || !confirmable) return;
    if (command.current.snapshotId !== v.snapshot.id) command.current = { snapshotId: v.snapshot.id, id: newCommandId() };
    setAck({ kind: "sending" });
    try {
      const res = await doFetch(`${path}/ack`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId: v.snapshot.id, ackSeq: v.snapshot.ackSeq, shownIds: v.items.map((i) => i.id), commandId: command.current.id }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { checkpoint?: { receiptId?: string } };
        return setAck(body.checkpoint?.receiptId ? { kind: "done", receiptId: body.checkpoint.receiptId } : { kind: "done" });
      }
      if (res.status === 401) return setState((s) => ({ phase: "signed-out", view: s.view }));
      const problem = (await res.json().catch(() => ({}))) as { code?: string };
      setAck(problem.code ? { kind: "refused", code: problem.code } : { kind: "failed" });
    } catch {
      setAck({ kind: "offline" });
    }
  };

  const toggleVersions = async (id: string) => {
    if (open[id]) return setOpen((o) => ({ ...o, [id]: undefined }));
    setOpen((o) => ({ ...o, [id]: "loading" }));
    try {
      const res = await doFetch(`/api/me/items/${encodeURIComponent(id)}/history`);
      if (!res.ok) return setOpen((o) => ({ ...o, [id]: "failed" }));
      const body = (await res.json()) as { history: History };
      setOpen((o) => ({ ...o, [id]: body.history }));
    } catch {
      setOpen((o) => ({ ...o, [id]: "failed" }));
    }
  };

  const setRequired = async (sourceId: string, required: boolean) => {
    setRequiredError(false);
    try {
      const res = await doFetch(`/api/projects/${encodeURIComponent(props.projectId)}/sources/${encodeURIComponent(sourceId)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ required }),
      });
      if (!res.ok) return setRequiredError(true);
      await load();
    } catch {
      setRequiredError(true);
    }
  };

  const banner = (role: "status" | "alert", text: string, key: string) =>
    createElement("p", { key, role, "data-result": key, className: "mb-4 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] leading-relaxed text-ink-2" }, text);

  let body: ReactElement;
  if (state.phase === "loading") body = createElement("p", { role: "status", className: "text-[14px] text-ink-3" }, t.today.loading);
  else if (state.phase === "signed-out" && !v)
    body = createElement("div", null,
      createElement("p", { role: "status", className: "text-[14px] text-ink-2" }, t.today.signedOut),
      createElement("a", { href: "/login", className: "mt-4 inline-flex h-11 items-center rounded-full border border-line-strong bg-surface px-5 text-[14px] font-medium text-ink-2" }, t.today.goSignIn),
    );
  else if (state.phase === "not-found") body = createElement("p", { role: "status", className: "text-[14px] text-ink-2" }, t.today.notFound);
  else if (state.phase === "offline" && !v) body = banner("status", t.today.offline, "offline-or-auth");
  else if (state.phase === "failed" || !v) body = createElement("p", { role: "alert", className: "text-[14px] text-hot" }, t.today.failed);
  else {
    const required = (v.coverage?.sources ?? []).filter((s) => s.required && s.status !== "checked");
    const banners: ReactElement[] = [];
    if (result === "offline-or-auth") {
      banners.push(state.phase === "offline"
        ? banner("status", t.today.offline, "offline-or-auth")
        : createElement("p", { key: "auth", role: "status", "data-result": "offline-or-auth", className: "mb-4 text-[13.5px] text-ink-2" },
            t.today.signedOut, " ", createElement("a", { href: "/login", className: "underline" }, t.today.goSignIn)));
    } else if (result === "snapshot-failed") banners.push(banner("alert", t.today.snapshotFailed, result));
    else if (result === "partial-coverage") banners.push(banner("status", t.today.partialCoverage(required.map((s) => s.name).join(t.today.listSeparator)), result));
    else if (result === "abstained-impact") banners.push(banner("status", t.today.abstained(v.unassessed ?? v.awaitingAnalysis), result));

    const list = v.items.length === 0
      ? createElement("section", { role: "status", "aria-label": zhOr(v.emptyState?.title, t.today.noImportantChange), className: "rounded-2xl border border-line bg-surface px-4 py-6 text-center" },
          createElement("div", { className: "text-[16px] font-semibold text-ink" }, zhOr(v.emptyState?.title, t.today.noImportantChange)),
          createElement("p", { className: "mt-2 text-[13.5px] leading-relaxed text-ink-3" }, zhOr(v.emptyState?.detail, t.today.noChangeDetail(v.window?.basis))),
        )
      : createElement("ol", { className: "flex flex-col gap-3" },
          v.items.map((item, i) => {
            const versions = open[item.id];
            return createElement("li", { key: item.id, className: "rounded-2xl border border-line bg-surface px-4 py-3" },
              createElement("div", { className: "flex flex-wrap items-center gap-2 text-[12px] text-ink-4" },
                createElement("span", null, `${i + 1} / ${v.items.length}${item.selected ? t.today.selectedSuffix : ""}`),
                item.ledger === "corrected" ? createElement("span", { "data-ledger": "corrected", className: "rounded bg-surface-2 px-1.5 text-[11px] text-ink-3" }, t.today.corrected) : null,
              ),
              createElement("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", className: "mt-1 block text-[15.5px] font-medium leading-snug text-ink" }, item.title),
              item.originalTitle ? createElement("div", { className: "mt-0.5 text-[12.5px] text-ink-4" }, item.originalTitle) : null,
              item.summary
                ? createElement("p", { className: "mt-2 text-[13.5px] leading-relaxed text-ink-2" },
                    createElement("span", { className: "mr-1 rounded bg-surface-2 px-1 text-[11px] text-ink-4" }, t.today.analysisBadge), " ", item.summary)
                : null,
              createElement("div", { className: "mt-2 flex flex-wrap gap-x-2 text-[12px] text-ink-4" },
                createElement("span", null, item.source.name),
                createElement("span", null, shortTime(item.publishedAt ?? item.listedAt, locale, timeZone)),
                createElement("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", className: "underline" }, t.today.viewOriginal),
                item.ledger === "corrected"
                  ? createElement("button", { type: "button", onClick: () => void toggleVersions(item.id), className: "underline" }, versions ? t.today.hideVersions : t.today.showVersions)
                  : null,
              ),
              item.confirmedSignals?.length
                ? createElement("p", { "data-confirmed-signal": item.id, className: "mt-1.5 text-[12px] text-ink-4" },
                    item.confirmedSignals.map((c) => t.discover.confirmedCard(c.kind === "user-lead" ? t.discover.channelLead : c.channelName)).join(" · "))
                : null,
              versions === "loading" ? createElement("p", { role: "status", className: "mt-2 text-[12px] text-ink-4" }, t.today.versionsLoading) : null,
              versions === "failed" ? createElement("p", { role: "alert", className: "mt-2 text-[12px] text-hot" }, t.today.versionsFailed) : null,
              versions && typeof versions === "object"
                ? createElement("ul", { "data-versions": item.id, className: "mt-2 flex flex-col gap-1 border-l border-line pl-3 text-[12.5px] text-ink-3" },
                    ...versions.revisions.map((r) => createElement("li", { key: `r${r.revision}` },
                      createElement("span", { className: "text-ink-4" }, t.today.versionLine(r.revision, shortTime(r.recordedAt, locale, timeZone))), " ", r.title)),
                    ...versions.conflicts.map((c, k) => createElement("li", { key: `c${k}` },
                      createElement("span", { className: "text-ink-4" }, t.today.conflictLine(shortTime(c.reportedAt, locale, timeZone))), " ", c.title)),
                  )
                : null,
            );
          }),
        );

    const coverage = v.coverage?.sources.length
      ? createElement("section", { className: "mt-6", "aria-label": t.today.coverageTitle },
          createElement("div", { className: "text-[12.5px] font-medium text-ink-3" }, t.today.coverageTitle),
          createElement("ul", { className: "mt-2 flex flex-col gap-1.5 text-[12.5px] text-ink-3" },
            v.coverage.sources.map((s) =>
              createElement("li", { key: s.sourceId, "data-source": s.sourceId, className: "flex flex-wrap items-center gap-2" },
                createElement("span", { className: "text-ink-2" }, s.name),
                createElement("span", { "data-status": s.status, className: s.status === "checked" ? "text-ink-4" : "text-hot" }, t.today.coverageStatus[s.status]),
                s.checkedAtUtc ? createElement("span", { className: "text-ink-4" }, shortTime(s.checkedAtUtc, locale, timeZone)) : null,
                createElement("label", { className: "ml-auto inline-flex items-center gap-1 text-ink-4" },
                  createElement("input", { type: "checkbox", checked: s.required, disabled: offlineOrAuth, onChange: () => void setRequired(s.sourceId, !s.required) }),
                  t.today.requiredLabel),
              ),
            ),
          ),
          createElement("p", { className: "mt-1 text-[11.5px] text-ink-4" }, t.today.requiredHint),
          requiredError ? createElement("p", { role: "alert", className: "mt-1 text-[12px] text-hot" }, t.today.requiredFailed) : null,
        )
      : null;

    const refusedText = ack.kind === "refused" ? (t.today.ackRefused as Record<string, string>)[ack.code] ?? t.today.ackFailed : null;
    const doneReceipt = ack.kind === "done" && "receiptId" in ack ? ack.receiptId : null;
    body = createElement("div", null,
      ...banners,
      list,
      v.awaitingAnalysis > 0 && result !== "abstained-impact" ? createElement("p", { className: "mt-3 text-[12.5px] text-ink-4" }, t.today.awaitingAnalysis(v.awaitingAnalysis)) : null,
      createElement("div", { className: "mt-6 flex flex-col items-start gap-1" },
        createElement("button", {
          type: "button", onClick: acknowledge, disabled: !confirmable || ack.kind === "sending" || ack.kind === "done",
          className: "inline-flex h-11 min-w-[44px] items-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-contrast disabled:opacity-60",
        }, t.today.ack),
        confirmable ? null : createElement("p", { className: "text-[11.5px] text-ink-4" }, t.today.ackBlocked),
        v.checkpoint.readThrough && ack.kind !== "done" ? createElement("p", { className: "text-[11.5px] text-ink-4" }, t.today.lastConfirmed(shortTime(v.checkpoint.readThrough, locale, timeZone))) : null,
        ack.kind === "done" ? createElement("p", { role: "status", className: "text-[12.5px] text-ink-3" }, t.today.ackDone, doneReceipt ? ` ${t.today.receipt(doneReceipt)}` : "") : null,
        ack.kind === "failed" ? createElement("p", { role: "alert", className: "text-[12.5px] text-hot" }, t.today.ackFailed) : null,
        ack.kind === "offline" ? createElement("p", { role: "alert", className: "text-[12.5px] text-hot" }, t.today.offline) : null,
        refusedText ? createElement("p", { role: "alert", className: "text-[12.5px] text-hot" }, refusedText, " ",
          createElement("button", { type: "button", onClick: () => void load(), className: "underline" }, t.today.refresh)) : null,
      ),
      coverage,
    );
  }

  return createElement("div", { className: "mag-page" },
    createElement("div", { className: "mag-title" }, t.today.title),
    createElement("h1", { className: "text-[24px] leading-[32px] font-semibold text-ink", lang: textLang(v?.project.target, locale) }, v?.project.target ?? t.today.projectFallback),
    v ? createElement("p", { className: "mt-1 text-[15px] leading-relaxed text-ink-2", lang: textLang(v.project.purpose, locale) }, v.project.purpose) : null,
    v ? createElement("p", { className: "mt-0.5 text-[12.5px] text-ink-3", "data-sources-line": "" }, t.today.sourcesLine(v.sources.linked, v.sources.active, shortTime(v.window.since, locale, timeZone), v.window.basis)) : null,
    v ? sourcesNotice(v.sources, locale) : null,
    createElement("div", { className: "mt-5" }, body),
    // Evidence above, unconfirmed signals below, kept apart (master design 2.2).
    state.phase === "ready" ? createElement(SignalsAwaitingSection, { projectId: props.projectId, fetchImpl: props.fetchImpl }) : null,
  );
};
