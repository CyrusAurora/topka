// The guided creation wizard (master design J2, construction step 3): pack, sources, naming, confirm
// card and done screen, with the handover's copy locked verbatim. The component is a plain .ts
// factory because the component tests run under node --test, which cannot load JSX; the route file
// is a thin shell around it.
import { createElement, useEffect, useState, type FC, type ReactElement } from "react";
import { SOURCE_REGION_TOKENS, sourceMatchesRegionFilter } from "@topka/contracts/regions";

export interface PackSourceView {
  id: string;
  name: string;
  publisher: string | null;
  regions?: string[];
}

export interface PackView {
  id: string;
  label: string;
  sources: PackSourceView[];
  /** The pack's sources are real, collectable rows in this instance. */
  available?: boolean;
}

export interface PrefsView {
  packId: string | null;
  picks: string[];
}

// --- locked copy (handover §2.2) --------------------------------------------

export const PACKS_LOADING = "正在读策展包……";
export const PACKS_UNAVAILABLE = "策展包暂时不可用，稍后再试。";
export const EMPTY_PACK_HINT = "这个包还没有配好来源清单，直接下一步起名也行。";
export const GOAL_PURPOSE_REQUIRED = "目标和方向都要有，回去补一句描述再来。";
export const NAME_REQUIRED = "起个名字再创建。";
export const DONE_TITLE = "跟踪项目建好了";
export const DONE_NOTICE = "采集每天早晚各跑一次，新动态会进简报。";
export const OFFLINE_COPY = "没网，稍后再试。";
export const CREATE_FAILED_COPY = "创建没有成功，请稍后再试。";
export const WIZARD_TITLE = "选个方向开始盯";
export const WIZARD_SUBTITLE = "四步：选包，挑来源，起个名，确认一下。不用填表。";
export const NAMING_TITLE = "第三步：起个名就建好";
export const NAMING_LABEL = "项目名（留空则用包名）";
export const CONFIRM_LEAD = "以下是我理解的跟踪方向，确认后开始跟踪：";
export const CONFIRM_SUBTITLE = "核对一下，没问题就创建";
export const SOURCE_INFO_TAIL = "个包内来源持续更新。";

/** Assembles the tracking purpose from the picks (handover §2.2, confirm card rules). */
export function assemblePurpose(pack: PackView, picks: readonly string[]): string {
  const names = picks
    .map((id) => pack.sources.find((source) => source.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return `跟踪${pack.label}方向，覆盖全部${pack.sources.length}个来源`;
  if (names.length <= 3) return `跟踪${pack.label}方向，重点看${names.join("、")}`;
  return `跟踪${pack.label}方向，重点看${names.slice(0, 3).join("、")}等${names.length}个来源`;
}

/**
 * The draft gate, with the handover's refusal copy attached by the caller: a missing purpose refuses
 * as 「目标和方向都要有…」; a target that would end up empty — the raw name is empty and there is no
 * pack label to fall back on — refuses as 「起个名字再创建。」. With a pack, an empty name simply
 * falls back to the pack label and nothing is refused.
 */
export function validateDraft(input: { target: string; purpose: string; pack: PackView | null }): "goal-purpose" | "name" | null {
  if (!input.purpose.trim()) return "goal-purpose";
  const effective = input.target.trim() || input.pack?.label.trim() || "";
  if (!effective) return "name";
  return null;
}

export function effectiveTarget(name: string, pack: PackView | null): string {
  return name.trim() || (pack?.label.trim() ?? "");
}

/** Filter a pack's sources by region (same rule as the API: empty = all, `global` always visible). */
export function filterSourcesByRegion(sources: readonly PackSourceView[], filter: readonly string[]): PackSourceView[] {
  return sources.filter((source) => sourceMatchesRegionFilter(source.regions ?? ["global"], filter));
}

export const REGION_FILTER_LABEL = "按区域找";
export const REGION_FILTER_ALL = "全部";

// --- the component -----------------------------------------------------------

type Step = "packs" | "sources" | "naming" | "confirm" | "done";

interface WizardState {
  phase: "loading" | "ready" | "unavailable";
  packs: PackView[];
  prefs: PrefsView | null;
  step: Step;
  packId: string | null;
  picks: string[];
  name: string;
  problem: "goal-purpose" | "name" | null;
  creating: boolean;
  created: boolean;
  createdProject: { id: string; target: string; purpose: string } | null;
  createError: string | null;
  regionFilter: string[];
}

const initialState: WizardState = {
  phase: "loading",
  packs: [],
  prefs: null,
  step: "packs",
  packId: null,
  picks: [],
  name: "",
  problem: null,
  creating: false,
  created: false,
  createdProject: null,
  createError: null,
  regionFilter: [],
};

export interface GuidedCreationProps {
  fetchImpl?: typeof fetch;
}

export const GuidedCreation: FC<GuidedCreationProps> = (props) => {
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const [state, setState] = useState<WizardState>(initialState);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const packsRes = await doFetch("/api/packs");
        if (!alive) return;
        if (!packsRes.ok) {
          setState((s) => ({ ...s, phase: "unavailable" }));
          return;
        }
        const packsBody = (await packsRes.json()) as { packs?: PackView[] };
        let prefs: PrefsView | null = null;
        try {
          const prefsRes = await doFetch("/api/pack-prefs");
          if (prefsRes.ok) {
            const body = (await prefsRes.json()) as PrefsView;
            if (body && typeof body.packId === "string") prefs = { packId: body.packId, picks: Array.isArray(body.picks) ? body.picks.filter((p) => typeof p === "string") : [] };
          }
        } catch {
          // A preference that cannot be read is simply not offered back.
        }
        if (!alive) return;
        setState((s) => ({ ...s, phase: "ready", packs: Array.isArray(packsBody.packs) ? packsBody.packs : [], prefs, step: "packs" }));
      } catch {
        if (alive) setState((s) => ({ ...s, phase: "unavailable" }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pack = state.packId ? state.packs.find((p) => p.id === state.packId) ?? null : null;
  const target = effectiveTarget(state.name, pack);
  const purpose = pack ? assemblePurpose(pack, state.picks) : "";

  const choosePack = (chosen: PackView) => {
    if (chosen.available === false) return;
    setState((s) => ({ ...s, step: "sources", packId: chosen.id, picks: [], name: "", problem: null, createError: null }));
    // The choice becomes the user's preference; a failure keeps the wizard usable.
    void doFetch("/api/pack-prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ packId: chosen.id, picks: [] }) }).catch(() => {});
  };

  const usePrevious = () => {
    const previous = state.prefs ? state.packs.find((p) => p.id === state.prefs!.packId) : null;
    if (!previous || previous.available === false) return;
    const ids = new Set(previous.sources.map((source) => source.id));
    setState((s) => ({ ...s, step: "sources", packId: previous.id, picks: (s.prefs?.picks ?? []).filter((id) => ids.has(id)), name: "", problem: null, createError: null }));
  };

  const preview = () => {
    const problem = validateDraft({ target: state.name, purpose, pack });
    setState((s) => ({ ...s, problem, step: problem ? "naming" : "confirm" }));
  };

  const confirm = async () => {
    // One-shot guard: repeated confirmation creates exactly once (the api is idempotent too).
    if (state.creating || state.created || !pack) return;
    setState((s) => ({ ...s, creating: true, createError: null }));
    const sourceIds = state.picks.length > 0 ? state.picks : pack.sources.map((source) => source.id);
    try {
      const res = await doFetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, purpose, sourceIds }),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { detail?: string };
        setState((s) => ({ ...s, creating: false, createError: problem.detail ?? CREATE_FAILED_COPY }));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { project?: { id?: string } };
      setState((s) => ({ ...s, creating: false, created: true, step: "done", createdProject: { id: body.project?.id ?? "", target, purpose } }));
    } catch {
      setState((s) => ({ ...s, creating: false, createError: OFFLINE_COPY }));
    }
  };

  const button = "inline-flex h-11 items-center justify-center rounded-full px-5 text-[14px] font-medium transition-colors disabled:opacity-45";
  const primary = `${button} bg-accent text-accent-contrast hover:bg-accent-ink`;
  const secondary = `${button} border border-line-strong bg-surface text-ink-2 hover:border-ink-4 hover:text-ink`;
  const row = (label: string, value: string) => (
    createElement("div", { key: label, className: "mt-3" },
      createElement("div", { className: "text-[12px] text-ink-3" }, label),
      createElement("div", { className: "mt-0.5 text-[14.5px] leading-relaxed text-ink" }, value),
    )
  );

  let body: ReactElement;
  if (state.phase === "loading") {
    body = createElement("p", { role: "status", className: "mt-8 text-[14px] text-ink-3" }, PACKS_LOADING);
  } else if (state.phase === "unavailable") {
    body = createElement("p", { role: "alert", className: "mt-8 text-[14px] text-hot" }, PACKS_UNAVAILABLE);
  } else if (state.step === "packs") {
    const previous = state.prefs ? state.packs.find((p) => p.id === state.prefs!.packId) : null;
    body = createElement("div", null,
      previous && createElement("div", { className: "mb-5 rounded-2xl bg-bg-sunk px-4 py-3 text-[13px] text-ink-2" },
        `上次你选了${previous.label}包`,
        createElement("button", { type: "button", onClick: usePrevious, className: `${secondary} mt-2 w-full` }, "直接用上次的"),
      ),
      createElement("div", { className: "flex flex-col gap-2" },
        state.packs.map((p) =>
          p.available === false
            ? createElement("div", { key: p.id, className: `${secondary} justify-between opacity-55`, "aria-disabled": "true" },
                createElement("span", null, `${p.label}（${p.sources.length} 个源）`),
                createElement("span", { className: "text-[12px] text-ink-3" }, "暂不可用"),
              )
            : createElement("button", { key: p.id, type: "button", onClick: () => choosePack(p), className: `${secondary} justify-start` }, `${p.label}（${p.sources.length} 个源）`),
        ),
      ),
    );
  } else if (state.step === "sources" && pack) {
    const visible = filterSourcesByRegion(pack.sources, state.regionFilter);
    body = createElement("div", null,
      createElement("h2", { className: "text-[15px] font-semibold text-ink" }, `第二步：${pack.label}包盯这些来源，勾上重点看的`),
      createElement("div", { className: "mt-3 flex flex-wrap items-center gap-1.5", "aria-label": REGION_FILTER_LABEL },
        createElement("span", { className: "mr-1 text-[12px] text-ink-3" }, REGION_FILTER_LABEL),
        createElement("button", {
          key: "all",
          type: "button",
          "aria-pressed": state.regionFilter.length === 0,
          onClick: () => setState((s) => ({ ...s, regionFilter: [] })),
          className: state.regionFilter.length === 0 ? `${primary} !h-8 !px-3 !text-[12px]` : `${secondary} !h-8 !px-3 !text-[12px]`,
        }, REGION_FILTER_ALL),
        ...SOURCE_REGION_TOKENS.filter((t) => t !== "global").map((token) => {
          const active = state.regionFilter.includes(token);
          return createElement("button", {
            key: token,
            type: "button",
            "aria-pressed": active,
            onClick: () => setState((s) => ({ ...s, regionFilter: active ? s.regionFilter.filter((r) => r !== token) : [...s.regionFilter, token] })),
            className: active ? `${primary} !h-8 !px-3 !text-[12px]` : `${secondary} !h-8 !px-3 !text-[12px]`,
          }, token.toUpperCase());
        }),
      ),
      visible.length === 0
        ? createElement("p", { role: "status", className: "mt-4 text-[13.5px] text-ink-2" }, pack.sources.length === 0 ? EMPTY_PACK_HINT : "这个区域没有来源，换个区域或选全部。")
        : createElement("ul", { className: "mt-4 flex flex-col gap-2" },
            visible.map((source) =>
              createElement("li", { key: source.id },
                createElement("label", { className: "flex min-h-11 items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-2 text-[14px] text-ink" },
                  createElement("input", {
                    type: "checkbox",
                    checked: state.picks.includes(source.id),
                    onChange: () =>
                      setState((s) => ({ ...s, picks: s.picks.includes(source.id) ? s.picks.filter((id) => id !== source.id) : [...s.picks, source.id] })),
                    className: "size-4 accent-[var(--color-accent)]",
                  }),
                  createElement("span", null, source.name),
                  source.publisher ? createElement("span", { className: "text-[12px] text-ink-3" }, `（${source.publisher}）`) : null,
                ),
              ),
            ),
          ),
      createElement("div", { className: "mt-6 flex gap-2" },
        createElement("button", { type: "button", onClick: () => setState((s) => ({ ...s, step: "naming", problem: null })), className: primary }, "就这些，下一步"),
        createElement("button", { type: "button", onClick: () => setState((s) => ({ ...s, step: "packs", packId: null, picks: [] })), className: secondary }, "换个包"),
      ),
    );
  } else if (state.step === "naming" && pack) {
    const first = state.picks.length > 0 ? pack.sources.find((source) => source.id === state.picks[0]) : null;
    const infoLine = first
      ? `${first.name}${first.publisher ? `（${first.publisher}）` : ""}；另有${pack.sources.length - 1}${SOURCE_INFO_TAIL}`
      : `覆盖全部${pack.sources.length}个来源。`;
    body = createElement("div", null,
      createElement("h2", { className: "text-[15px] font-semibold text-ink" }, NAMING_TITLE),
      createElement("p", { className: "mt-2 text-[13px] leading-relaxed text-ink-2" }, infoLine),
      createElement("label", { htmlFor: "project-name", className: "mt-5 block text-[13px] font-medium text-ink-2" }, NAMING_LABEL),
      createElement("input", {
        id: "project-name",
        type: "text",
        value: state.name,
        onChange: (e) => setState((s) => ({ ...s, name: (e.target as HTMLInputElement).value, problem: null })),
        placeholder: pack.label,
        className: "mt-2 h-11 w-full rounded-full border border-line-strong bg-surface px-4 text-[14.5px] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent",
      }),
      state.problem && createElement("p", { role: "alert", className: "mt-3 text-[12.5px] text-hot" }, state.problem === "goal-purpose" ? GOAL_PURPOSE_REQUIRED : NAME_REQUIRED),
      createElement("div", { className: "mt-6 flex gap-2" },
        createElement("button", { type: "button", onClick: preview, className: primary }, "预览确认"),
        createElement("button", { type: "button", onClick: () => setState((s) => ({ ...s, step: "sources" })), className: secondary }, "回去改来源"),
      ),
    );
  } else if (state.step === "confirm" && pack) {
    const names = state.picks.map((id) => pack.sources.find((source) => source.id === id)?.name).filter((n): n is string => Boolean(n));
    const summary = names.length > 0 ? `重点看${names.join("、")}` : `覆盖全部${pack.sources.length}个来源`;
    body = createElement("div", null,
      createElement("h2", { className: "text-[16px] font-semibold text-ink" }, `${pack.label} · 创建确认`),
      createElement("p", { className: "mt-1 text-[13px] text-ink-3" }, CONFIRM_SUBTITLE),
      createElement("p", { className: "mt-4 text-[13.5px] text-ink-2" }, CONFIRM_LEAD),
      createElement("div", { className: "mt-2 rounded-2xl border border-line bg-surface px-4 py-3" },
        row("跟踪目标", target),
        row("跟踪目的", purpose),
        row("来源包摘要", summary),
      ),
      state.createError && createElement("p", { role: "alert", className: "mt-3 text-[12.5px] text-hot" }, state.createError),
      createElement("div", { className: "mt-6 flex gap-2" },
        createElement("button", { type: "button", onClick: () => void confirm(), disabled: state.creating || state.created, className: primary }, state.creating ? "正在创建…" : "确认创建"),
        createElement("button", { type: "button", onClick: () => setState((s) => ({ ...s, step: "naming" })), disabled: state.creating, className: secondary }, "回去改"),
      ),
    );
  } else if (state.step === "done" && state.createdProject) {
    body = createElement("div", null,
      createElement("h2", { className: "text-[16px] font-semibold text-ink" }, DONE_TITLE),
      createElement("div", { className: "mt-3 rounded-2xl border border-line bg-surface px-4 py-3" },
        row("跟踪目标", state.createdProject.target),
        row("跟踪目的", state.createdProject.purpose),
      ),
      createElement("p", { className: "mt-4 text-[13px] leading-relaxed text-ink-2" }, DONE_NOTICE),
      createElement("a", { href: "/projects", className: `${secondary} mt-6` }, "回到项目总览"),
    );
  } else {
    body = createElement("p", { className: "mt-8 text-[14px] text-ink-3" }, PACKS_UNAVAILABLE);
  }

  return createElement("div", { className: "mx-auto w-full max-w-[560px] px-4 py-10" },
    createElement("h1", { className: "text-[17px] font-semibold text-ink" }, WIZARD_TITLE),
    createElement("p", { className: "mt-1 text-[13px] text-ink-3" }, WIZARD_SUBTITLE),
    createElement("div", { className: "card mt-6 p-6" }, body),
  );
}
