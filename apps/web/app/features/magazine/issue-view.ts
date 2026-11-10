// The magazine's single-issue reader (往期 → 单期), /issue/:date. Same card chrome as 今日
// (features/magazine/today.ts): masthead with the issue's own day and number, the cards, expand in
// place, copy the link. Reads GET /api/me/issues/:date; expanding POSTs /api/me/issues/read like
// 今日 does.
// The endpoint answers { issue } only (no opened/projects), so the read marks come back empty and
// the project label is what the issue's own items carry.
import { createElement, useCallback, useEffect, useState, type FC, type ReactElement } from "react";
import { useT, useUiPrefs } from "../../lib/i18n.ts";
import { cardMeta, hostOf, masthead, type CardRow, type IssueCard } from "./view.ts";

export interface MagazineIssueProps {
  date: string;
  fetchImpl?: typeof fetch;
}

type Phase = "loading" | "signed-out" | "not-found" | "failed" | "ready";

interface IssueState {
  phase: Phase;
  issue: IssueCard | null;
}

export const MagazineIssue: FC<MagazineIssueProps> = (props) => {
  const t = useT();
  const { locale, timeZone } = useUiPrefs();
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const path = `/api/me/issues/${encodeURIComponent(props.date)}`;
  const [state, setState] = useState<IssueState>({ phase: "loading", issue: null });
  const [openId, setOpenId] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [readSet, setReadSet] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    setState({ phase: "loading", issue: null });
    setOpenId("");
    setCopiedId("");
    setReadSet(new Set());
    try {
      const res = await doFetch(path);
      if (res.status === 401) {
        setState({ phase: "signed-out", issue: null });
        return;
      }
      if (res.status === 404) {
        setState({ phase: "not-found", issue: null });
        return;
      }
      if (!res.ok) {
        setState({ phase: "failed", issue: null });
        return;
      }
      const body = (await res.json()) as { issue?: IssueCard | null };
      setState({ phase: body.issue ? "ready" : "not-found", issue: body.issue ?? null });
    } catch {
      setState({ phase: "failed", issue: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = state.issue;

  const expand = (row: CardRow) => {
    if (openId === row.id) {
      setOpenId("");
      return;
    }
    setOpenId(row.id);
    if (!row.read && !readSet.has(row.id)) {
      setReadSet((prev) => new Set(prev).add(row.id));
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

  const titleEl = createElement("h1", { className: "mag-title" }, t.magazine.issueTitle(props.date));

  if (state.phase === "loading") {
    return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-6" },
      titleEl,
      createElement("p", { role: "status", className: "mag-note" }, t.magazine.issueLoading),
    );
  }

  if (state.phase === "signed-out") {
    return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-16" },
      titleEl,
      createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, t.magazine.signedOut),
        createElement("a", { href: "/login", className: "e-cta" }, t.magazine.goToLogin),
      ),
    );
  }

  if (state.phase === "not-found") {
    return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-16" },
      titleEl,
      createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, t.magazine.notFoundTitle),
        createElement("div", { className: "e-s" }, t.magazine.notFoundSub),
        createElement("a", { href: "/archive", className: "e-cta mt-4" }, t.magazine.backToArchive),
      ),
    );
  }

  if (state.phase === "failed" || !issue) {
    return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-16" },
      titleEl,
      createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, t.magazine.failed),
        createElement("a", { href: "/archive", className: "e-cta mt-4" }, t.magazine.backToArchive),
      ),
    );
  }

  const head = masthead(issue.date, locale);
  const items = issue.items;
  const multiProjects = new Set(items.map((i) => i.project.id)).size > 1;

  const rows: CardRow[] = items.map((item) => ({
    id: item.id,
    no: String(item.position).padStart(2, "0"),
    title: [item.title_a, item.title_b].filter(Boolean).join(" "),
    core: [item.core_a, item.core_b].filter(Boolean).join(" "),
    source: item.source,
    when: "",
    project: multiProjects ? item.project.target : "",
    multi: multiProjects,
    url: item.url,
    host: hostOf(item.url),
    summary: item.summary,
    tag: item.tag,
    read: readSet.has(item.id),
  }));

  const body: ReactElement = items.length === 0
    ? createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, t.magazine.emptyIssueTitle),
        createElement("div", { className: "e-s" }, t.magazine.emptyIssueSub),
      )
    : createElement("div", { className: "mag-list" },
        rows.map((row, i) => {
          const open = openId === row.id;
          const hero = issue.hero === true && i === 0 && rows.length === 3;
          const item = items[i]!;
          return createElement("article", { key: row.id, className: `mag-item ${hero ? "hero" : ""} ${row.read ? "read" : ""} ${open ? "open" : ""}` },
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
                  createElement("span", { className: "m-src" }, cardMeta(item, multiProjects, new Date(), locale, timeZone)),
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
                    createElement("button", { type: "button", className: "m-close hit", onClick: () => setOpenId("") }, t.magazine.collapse),
                  ),
                ),
              ),
            ) : null,
          );
        }),
      );

  return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-6" },
    createElement("div", { className: "mag-masthead" },
      createElement("div", { className: "mag-masthead-row" },
        createElement("div", { className: "mag-date" },
          createElement("span", null, head.date),
          createElement("span", { className: "mag-wd" }, head.weekday),
        ),
        createElement("div", { className: "mag-issue" },
          createElement("div", { className: "mag-no" }, issue.no ? `No. ${String(issue.no).padStart(3, "0")}` : ""),
        ),
      ),
      createElement("div", { className: "mag-rule" }),
      createElement("div", { className: "mag-sub" },
        createElement("span", { className: "m-notice" }, t.magazine.noticeFallback),
      ),
    ),
    body,
    createElement("div", { className: "mag-foot" },
      createElement("div", { className: "f-row" },
        createElement("a", { className: "f-a hit", href: "/archive" }, t.magazine.backToArchive),
      ),
    ),
  );
};
