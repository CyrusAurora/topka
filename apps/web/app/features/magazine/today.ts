// The magazine's 今日 page (master design B1): masthead, the fixed 3 cards, expand in place, copy
// the original link, 往期 in the footer. A plain .ts factory for the node --test component tests;
// the route file is a thin shell around it. Reads /api/me/today with the visitor's session; a
// single issue reader reuses the same card list.
import { createElement, useCallback, useEffect, useState, type FC, type ReactElement } from "react";
import {
  cardRows,
  MAGAZINE_COPY,
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
function viewOf(payload: MagazineIssuePayload): TodayView {
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
    notice: payload.notice?.trim() || MAGAZINE_COPY.noticeFallback,
  };
}

export const MagazineToday: FC<MagazineTodayProps> = (props) => {
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
      setState({ phase: "ready", view: viewOf(payload) });
    } catch {
      setState({ phase: "failed", view: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      createElement("h1", { className: "mag-title" }, "今日"),
      createElement("p", { role: "status", className: "mag-note" }, MAGAZINE_COPY.loading),
    );
  }

  if (state.phase === "signed-out") {
    return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-16" },
      createElement("h1", { className: "mag-title" }, "今日"),
      createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, MAGAZINE_COPY.signedOut),
        createElement("a", { href: "/login", className: "e-cta" }, MAGAZINE_COPY.goToLogin),
        createElement("a", { href: "/register", className: "e-cta mt-2" }, MAGAZINE_COPY.goToRegister),
      ),
    );
  }

  if (state.phase === "failed" || !v) {
    return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-16" },
      createElement("h1", { className: "mag-title" }, "今日"),
      createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, MAGAZINE_COPY.failed),
      ),
    );
  }

  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  // The masthead's day: the issue's own date when it is there; the reader's today while preparing.
  const day = v.issue?.date ?? `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const head = masthead(day);
  const rows = cardRows(v);
  const zeroSub = v.projects.length > 1 ? MAGAZINE_COPY.zeroSub : `「${v.projects[0]?.target ?? ""}」今天没有够分量的新进展。`;

  let body: ReactElement;
  if (v.phase === "first") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, MAGAZINE_COPY.firstTitle),
      createElement("div", { className: "e-s" }, MAGAZINE_COPY.firstSub),
      createElement("div", { className: "f-cta-group mt-5" },
        createElement("a", { href: "/chat", className: "f-cta" }, MAGAZINE_COPY.goChat),
        createElement("a", { href: "/projects/new", className: "f-cta secondary" }, MAGAZINE_COPY.goCreate),
      ),
    );
  } else if (v.phase === "preparing") {
    const label = v.projects.length > 1 ? `${v.projects.length} 个项目` : v.projects[0]?.target ?? "";
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, MAGAZINE_COPY.preparingTitle),
      createElement("div", { className: "e-s" }, `「${label}」有了新进展就会出现在这里，之后每天早上 8:00 更新。`),
    );
  } else if (v.phase === "zero") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, MAGAZINE_COPY.zeroTitle),
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
                createElement("span", { className: "m-tog" }, open ? "收起" : "展开"),
              ),
            ),
          ),
          open ? createElement("div", { className: "m-more" },
            createElement("div", { className: "m-more-in" },
              createElement("div", { className: "m-more-pad" },
                createElement("div", { className: "m-lab" }, "讲了什么 · AI 摘要"),
                row.summary
                  ? createElement("div", { className: "m-sum" }, row.summary)
                  : createElement("div", { className: "m-sum muted" }, "摘要还在路上，先看原文出处。"),
                createElement("div", { className: "m-src-row" },
                  createElement("span", { className: "m-host" }, row.host),
                  createElement("button", {
                    type: "button",
                    className: `m-copy hit ${copiedId === row.id ? "done" : ""}`,
                    onClick: () => void copy(row),
                  }, copiedId === row.id ? "已复制 ✓" : "复制原文链接"),
                ),
                createElement("div", { className: "m-acts" },
                  row.tag
                    ? createElement("a", { className: "m-mute hit", href: `/chat?prefill=${encodeURIComponent(`不想再看到「${row.tag}」这类内容`)}` }, `不想再看到「${row.tag}」这类`)
                    : null,
                  createElement("button", { type: "button", className: "m-close hit", onClick: () => setOpenId("") }, "收起"),
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
          createElement("div", { className: "mag-proj" }, projectLabelOf(v.projects)),
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
        createElement("span", { className: "f-l" }, MAGAZINE_COPY.updateEveryMorning),
        createElement("span", { className: "f-r" },
          createElement("a", { className: "f-a hit", href: "/archive" }, MAGAZINE_COPY.archive),
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
