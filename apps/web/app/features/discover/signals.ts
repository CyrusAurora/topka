// Pending-evidence signals on the reader's side (master design 2.2: "证据更新在上，待证风声在下";
// handover 2.9): the lower block of a project page — the capped pending list (chip, title or link,
// channel provenance, note), the reader's lead form, the recent promotions as lineage lines — and
// the shared pieces the /discover page uses. Signals are never mixed into the evidence above them,
// never confirmable, never counted as updates. Plain .ts factories for the node --test component
// tests; reads /api/projects/:id/signals with the visitor's session.
import { createElement, useCallback, useEffect, useState, type FC, type ReactElement } from "react";
import { useT, useUiPrefs, type Messages } from "../../lib/i18n.ts";
import { shortTime } from "../today/today-view.ts";

export type ChannelKind = "directory" | "pack" | "user-lead";

export interface SignalItem {
  id: string;
  kind: ChannelKind;
  channelName: string;
  url: string;
  title: string | null;
  note: string | null;
  discoveredAt: string;
  projectId: string | null;
  invalidUrl: boolean;
  duplicates?: number;
}

export interface PromotionItem extends SignalItem {
  promotedAt: string;
  observation: { id: string; title: string; url: string; sourceName: string } | null;
}

export interface PendingView {
  items: SignalItem[];
  total: number;
  hidden: number;
  cap: number;
}

export function isPending(v: unknown): v is PendingView {
  const p = v as PendingView | null;
  return !!p && Array.isArray(p.items) && typeof p.total === "number";
}

export function channelLabel(kind: ChannelKind, t: Messages["discover"]): string {
  return kind === "directory" ? t.channelDirectory : kind === "pack" ? t.channelPack : t.channelLead;
}

/** One pending signal: the chip, the title (or the link), provenance, note, and what makes it special. */
export function signalRow(s: SignalItem, t: Messages["discover"], when: (iso: string) => string, action?: ReactElement | null): ReactElement {
  const label = s.title || s.url;
  return createElement("li", { key: s.id, className: "rounded-2xl border border-dashed border-line px-4 py-3", "data-signal": s.id },
    createElement("div", { className: "flex items-start gap-2" },
      createElement("span", { className: "mt-0.5 shrink-0 rounded-full bg-bg-sunk px-2 py-0.5 text-[11px] text-ink-3", "data-awaiting-chip": "" }, t.awaitingChip),
      s.invalidUrl
        ? createElement("span", { className: "min-w-0 break-words text-[14px] text-ink-2" }, label)
        : createElement("a", { href: s.url, target: "_blank", rel: "noopener noreferrer nofollow", className: "min-w-0 break-words text-[14px] text-ink-2 hover:underline" }, label),
    ),
    createElement("p", { className: "mt-1 text-[12px] text-ink-4" },
      t.provenance(channelLabel(s.kind, t), s.kind === "user-lead" ? t.channelLead : s.channelName), " · ", t.discoveredAt(when(s.discoveredAt))),
    s.note ? createElement("p", { className: "mt-1 text-[12.5px] leading-relaxed text-ink-3" }, s.note) : null,
    s.invalidUrl ? createElement("p", { className: "mt-1 text-[12px] text-hot", "data-invalid-url": "" }, t.invalidUrl) : null,
    s.duplicates ? createElement("p", { className: "mt-1 text-[12px] text-ink-4" }, t.duplicates(s.duplicates)) : null,
    action ?? null,
  );
}

export function promotionRow(p: PromotionItem, t: Messages["discover"]): ReactElement {
  const channel = p.kind === "user-lead" ? t.channelLead : p.channelName;
  return createElement("li", { key: p.id, className: "text-[12.5px] leading-relaxed text-ink-3", "data-promotion": p.id },
    t.confirmedLine(channel, p.url, p.observation?.id ?? t.observationMissing),
    p.observation ? createElement("a", { href: p.observation.url, target: "_blank", rel: "noopener noreferrer", className: "ml-1 underline" }, p.observation.title || p.observation.url) : null,
  );
}

export interface SignalsSectionProps {
  projectId: string;
  fetchImpl?: typeof fetch;
}

type LeadState = { kind: "idle" | "sending" } | { kind: "saved" | "promoted" | "invalid" } | { kind: "rejected"; code: string };

/** The project page's lower block: pending signals, the lead form, and recent promotions. */
export const SignalsAwaitingSection: FC<SignalsSectionProps> = (props) => {
  const t = useT().discover;
  const { locale, timeZone } = useUiPrefs();
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const path = `/api/projects/${encodeURIComponent(props.projectId)}/signals`;
  const [state, setState] = useState<{ phase: "loading" | "ready" | "failed" | "hidden"; pending: PendingView | null; promoted: PromotionItem[] }>({ phase: "loading", pending: null, promoted: [] });
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [lead, setLead] = useState<LeadState>({ kind: "idle" });
  const [dismissFailed, setDismissFailed] = useState(false);
  const when = (iso: string) => shortTime(iso, locale, timeZone);

  const load = useCallback(async () => {
    try {
      const res = await doFetch(path);
      // Signed out or not this reader's project: the page above already says so.
      if (res.status === 401 || res.status === 404) return setState({ phase: "hidden", pending: null, promoted: [] });
      const body = res.ok ? ((await res.json().catch(() => null)) as { pending?: unknown; promoted?: unknown } | null) : null;
      if (!body || !isPending(body.pending)) return setState({ phase: "failed", pending: null, promoted: [] });
      setState({ phase: "ready", pending: body.pending, promoted: Array.isArray(body.promoted) ? (body.promoted as PromotionItem[]) : [] });
    } catch {
      setState({ phase: "failed", pending: null, promoted: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "hidden" || state.phase === "loading") return null;

  const submit = async () => {
    if (lead.kind === "sending") return;
    setLead({ kind: "sending" });
    try {
      const res = await doFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, note }) });
      const body = (await res.json().catch(() => ({}))) as { code?: string; promoted?: boolean; signal?: { invalidUrl?: boolean } };
      if (!res.ok) return setLead({ kind: "rejected", code: body.code ?? "failed" });
      setLead({ kind: body.promoted ? "promoted" : body.signal?.invalidUrl ? "invalid" : "saved" });
      setUrl("");
      setNote("");
      await load();
    } catch {
      setLead({ kind: "rejected", code: "failed" });
    }
  };

  const dismiss = async (id: string) => {
    setDismissFailed(false);
    try {
      const res = await doFetch(`${path}/${encodeURIComponent(id)}/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) return setDismissFailed(true);
      await load();
    } catch {
      setDismissFailed(true);
    }
  };

  const pending = state.pending;
  const leadMessage = lead.kind === "saved" ? t.leadSaved : lead.kind === "promoted" ? t.leadPromoted : lead.kind === "invalid" ? t.leadInvalid : lead.kind === "rejected" ? t.leadRejected(lead.code) : null;
  const input = "mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-4";
  return createElement("section", { id: "signals", className: "mt-10 border-t border-line pt-6", "aria-labelledby": "signals-title", "data-signals-section": "" },
    createElement("h2", { id: "signals-title", className: "text-[15px] font-semibold text-ink" }, t.awaitingTitle),
    createElement("p", { className: "mt-1 text-[12.5px] leading-relaxed text-ink-3" }, t.awaitingIntro),
    state.phase === "failed"
      ? createElement("p", { role: "alert", className: "mt-3 text-[13px] text-hot" }, t.loadFailed)
      : !pending || pending.items.length === 0
        ? createElement("p", { className: "mt-3 text-[13.5px] text-ink-3", "data-awaiting-empty": "" }, t.awaitingEmpty)
        : createElement("ul", { className: "mt-3 flex flex-col gap-2" },
          pending.items.map((s) => signalRow(s, t, when,
            createElement("button", { type: "button", onClick: () => void dismiss(s.id), className: "mt-2 text-[12px] text-ink-4 underline hover:text-ink-2" }, t.dismiss)))),
    pending && pending.hidden > 0 ? createElement("p", { className: "mt-2 text-[12px] text-ink-4" }, t.hidden(pending.hidden, pending.cap)) : null,
    dismissFailed ? createElement("p", { role: "alert", className: "mt-2 text-[12.5px] text-hot" }, t.dismissFailed) : null,
    state.phase === "ready"
      ? createElement("form", { className: "mt-5 rounded-2xl bg-bg-sunk px-4 py-3", onSubmit: (e: { preventDefault: () => void }) => { e.preventDefault(); void submit(); }, "data-lead-form": "" },
        createElement("div", { className: "text-[13px] font-medium text-ink-2" }, t.leadTitle),
        createElement("p", { className: "mt-0.5 text-[12px] leading-relaxed text-ink-4" }, t.leadHint),
        createElement("label", { className: "mt-2 block text-[12px] text-ink-3" }, t.leadUrl,
          createElement("input", { type: "text", inputMode: "url", value: url, onChange: (e: { target: { value: string } }) => setUrl(e.target.value), placeholder: t.leadUrlPlaceholder, className: input, maxLength: 4096, name: "url" })),
        createElement("label", { className: "mt-2 block text-[12px] text-ink-3" }, t.leadNote,
          createElement("input", { type: "text", value: note, onChange: (e: { target: { value: string } }) => setNote(e.target.value), placeholder: t.leadNotePlaceholder, className: input, maxLength: 1000, name: "note" })),
        createElement("button", { type: "submit", disabled: lead.kind === "sending" || !url.trim(), className: "mt-3 inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13px] text-ink-2 disabled:opacity-50" }, t.leadSubmit),
        leadMessage ? createElement("p", { role: lead.kind === "rejected" ? "alert" : "status", className: `mt-2 text-[12.5px] ${lead.kind === "rejected" ? "text-hot" : "text-ink-3"}` }, leadMessage) : null,
      )
      : null,
    state.promoted.length
      ? createElement("div", { className: "mt-5" },
        createElement("div", { className: "text-[12.5px] font-medium text-ink-3" }, t.confirmedTitle),
        createElement("ul", { className: "mt-1 flex flex-col gap-1" }, state.promoted.slice(0, 5).map((p) => promotionRow(p, t))))
      : null,
    createElement("a", { href: "/discover", className: "mt-4 inline-block text-[12px] text-ink-4 underline", "data-discover-link": "" }, t.pageTitle),
  );
};
