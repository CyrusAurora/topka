// The magazine's 今日 page (master design B1): masthead, the fixed 3 cards, expand in place, copy
// the original link, 往期 in the footer. A plain .ts factory for the node --test component tests;
// the route file is a thin shell around it. Reads /api/me/today with the visitor's session; a
// single issue reader reuses the same card list.
import { createElement, useCallback, useEffect, useState, type FC, type ReactElement } from "react";
import { issueDayIn } from "../../lib/issue-day.ts";
import { messages, useT, useUiPrefs, type UiLocale } from "../../lib/i18n.ts";
import {
  cardRows,
  masthead,
  projectLabelOf,
  type CardRow,
  type MagazineIssuePayload,
  type TodayView,
} from "./view.ts";

export interface MagazineTodayProps {
  /** The /api/me/… endpoints are cookie-authenticated; the test harness swaps the fetch. */
  fetchImpl?: typeof fetch;
}

type Phase = "loading" | "signed-out" | "failed" | "ready";

/** What 今天 shows, from the payload the reader has: the fixed issue, or its honest empty state. */
function viewOf(payload: MagazineIssuePayload, locale: UiLocale = "zh-CN"): TodayView {
  const t = messages(locale);
  const opened = payload.opened ?? [];
  const projects = payload.projects ?? [];
  const issue = payload.issue ?? null;
  const phase: TodayView["phase"] = !projects.length
    ? "first"
    : !issue
      ? "preparing"
      : !issue.items.length
        ? "zero"
        : "ready";
  return {
    phase,
    day: issue?.date ?? "",
    projects,
    issue,
    opened,
    archive: payload.archive ?? [],
    // The API's notice is fixed Chinese copy: an English page shows its own.
    notice: (locale === "zh-CN" && payload.notice?.trim()) || t.magazine.noticeFallback,
  };
}

export const MagazineToday: FC<MagazineTodayProps> = (props) => {
  const t = useT();
  const { locale, timeZone } = useUiPrefs();
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const [state, setState] = useState<{ phase: Phase; view: TodayView | null }>({ phase: "loading", view: null });
  const [openId, setOpenId] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [readSet, setReadSet] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const res = await doFetch("/api/me/today");
      if (res.status === 401) {
        setState({ phase: "signed-out", view: null });
        return;
      }
      if (!res.ok) {
        setState({ phase: "failed", view: null });
        return;
      }
      const payload = (await res.json()) as MagazineIssuePayload;
      setState({ phase: "ready", view: viewOf(payload, locale) });
    } catch {
      setState({ phase: "failed", view: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const v = state.view;

  const expand = (row: CardRow) => {
    if (openId === row.id) {
      setOpenId("");
      return;
    }
    setOpenId(row.id);
    if (!row.read && !readSet.has(row.id)) {
      setReadSet((prev) => new Set(prev).add(row.id));
      // The server marks the item read; a failure is not the reader's problem.
      void doFetch("/api/me/issues/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleId: row.id }),
      }).catch(() => {});
    }
  };

  const copy = async (row: CardRow) => {
    try {
      await navigator.clipboard.writeText(row.url);
      setCopiedId(row.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === row.id ? "" : cur)), 1500);
    } catch {
      // Clipboard unavailable; the link is still right there.
    }
  };

  if (state.phase === "loading") {
    return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-6" },
      createElement("h1", { className: "mag-title" }, t.magazine.today),
      createElement("p", { role: "status", className: "mag-note" }, t.magazine.loading),
    );
  }

  if (state.phase === "signed-out") {
    return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-16" },
      createElement("h1", { className: "mag-title" }, t.magazine.today),
      createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, t.magazine.signedOut),
        createElement("a", { href: "/login", className: "e-cta" }, t.magazine.goToLogin),
        createElement("a", { href: "/register", className: "e-cta mt-2" }, t.magazine.goToRegister),
      ),
    );
  }

  if (state.phase === "failed" || !v) {
    return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-16" },
      createElement("h1", { className: "mag-title" }, t.magazine.today),
      createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, t.magazine.failed),
      ),
    );
  }

  // The masthead's day: the issue's own date when it is there; while it is being prepared, the issue
  // day in the reader's time zone (not the browser's or the server's calendar).
  const day = v.issue?.date ?? issueDayIn(new Date(), timeZone);
  const head = masthead(day, locale);
  const rows = cardRows(v, new Date(), locale, timeZone);
  const zeroSub = v.projects.length > 1 ? t.magazine.zeroSub : t.magazine.zeroSubSingle(v.projects[0]?.target ?? "");

  let body: ReactElement;
  if (v.phase === "first") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, t.magazine.firstTitle),
      createElement("div", { className: "e-s" }, t.magazine.firstSub),
      createElement("div", { className: "f-cta-group mt-5" },
        createElement("a", { href: "/chat", className: "f-cta" }, t.magazine.goChat),
        createElement("a", { href: "/projects/new", className: "f-cta secondary" }, t.magazine.goCreate),
      ),
    );
  } else if (v.phase === "preparing") {
    const label = v.projects.length > 1 ? t.magazine.projectsCount(v.projects.length) : v.projects[0]?.target ?? "";
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, t.magazine.preparingTitle),
      createElement("div", { className: "e-s" }, t.magazine.preparingProject(label)),
    );
  } else if (v.phase === "zero") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, t.magazine.zeroTitle),
      createElement("div", { className: "e-s" }, zeroSub),
    );
  } else {
    body = createElement("div", { className: "mag-list" },
      rows.map((row) => {
        const open = openId === row.id;
        return createElement("article", { key: row.id, className: `mag-item ${row.read ? "read" : ""} ${open ? "open" : ""}` },
          createElement("div", {
            className: "m-row-t",
            onClick: () => expand(row),
            role: "button",
            tabIndex: 0,
            "aria-expanded": open,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                expand(row);
              }
            },
          },
            createElement("span", { className: "m-num", "aria-hidden": "true" }, row.no),
            createElement("div", { className: "m-body" },
              createElement("div", { className: "m-t" }, row.title),
              row.core ? createElement("div", { className: "m-why" }, row.core) : null,
              createElement("div", { className: "m-meta" },
                createElement("span", { className: "m-src" }, metaLine(row, v.projects.length > 1)),
                createElement("span", { className: "m-tog" }, open ? t.magazine.collapse : t.magazine.expand),
              ),
            ),
          ),
          open ? createElement("div", { className: "m-more" },
            createElement("div", { className: "m-more-in" },
              createElement("div", { className: "m-more-pad" },
                createElement("div", { className: "m-lab" }, t.magazine.summaryLabel),
                row.summary
                  ? createElement("div", { className: "m-sum" }, row.summary)
                  : createElement("div", { className: "m-sum muted" }, t.magazine.summaryPending),
                createElement("div", { className: "m-src-row" },
                  createElement("span", { className: "m-host" }, row.host),
                  createElement("button", {
                    type: "button",
                    className: `m-copy hit ${copiedId === row.id ? "done" : ""}`,
                    onClick: () => void copy(row),
                  }, copiedId === row.id ? t.magazine.copied : t.magazine.copyLink),
                ),
                createElement("div", { className: "m-acts" },
                  row.tag
                    ? createElement("a", { className: "m-mute hit", href: `/chat?prefill=${encodeURIComponent(t.magazine.muteTopicPrefill(row.tag))}` }, t.magazine.muteTopic(row.tag))
                    : null,
                  createElement("button", { type: "button", className: "m-close hit", onClick: () => setOpenId("") }, t.magazine.collapse),
                ),
              ),
            ),
          ) : null,
        );
      }),
    );
  }

  return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-6" },
    createElement("div", { className: "mag-masthead" },
      createElement("div", { className: "mag-masthead-row" },
        createElement("div", { className: "mag-date" },
          createElement("span", null, head.date),
          createElement("span", { className: "mag-wd" }, head.weekday),
        ),
        createElement("div", { className: "mag-issue" },
          createElement("div", { className: "mag-no" }, v.issue?.no ? `No. ${String(v.issue.no).padStart(3, "0")}` : ""),
          createElement("div", { className: "mag-proj" }, projectLabelOf(v.projects, locale)),
        ),
      ),
      createElement("div", { className: "mag-rule" }),
      createElement("div", { className: "mag-sub" },
        createElement("span", { className: "m-notice" }, v.notice),
      ),
    ),
    body,
    createElement("div", { className: "mag-foot" },
      createElement("div", { className: "f-row" },
        createElement("span", { className: "f-l" }, t.magazine.updateEveryMorning),
        createElement("span", { className: "f-r" },
          createElement("a", { className: "f-a hit", href: "/archive" }, t.magazine.archive),
        ),
      ),
    ),
  );
};

// The card's meta line goes through one place so the cards never drift from each other.
function metaLine(row: CardRow, multi: boolean): string {
  const parts = [`${row.source} · ${row.when}`];
  if (multi && row.project) parts.push(row.project);
  return parts.join(" · ");
}
