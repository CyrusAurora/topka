// The magazine's 往期 list (master design B2): the reader's past issues, newest first, from
// GET /api/me/issues — one line per day with the day's issue number and its titles, tapping a
// row reads that day (GET /api/me/issues/:date). Same page shell as 今日, a thin card list.
import { createElement, useEffect, useState, type FC, type ReactElement } from "react";
import { archiveRows, MAGAZINE_COPY } from "./view.ts";

export interface ArchiveEntryRow {
  date: string;
  no: number;
  titles: string[];
}

export interface ArchiveView {
  phase: "loading" | "signed-out" | "failed" | "ready";
  archive: ArchiveEntryRow[];
  issueCount: number;
}

export interface MagazineArchiveProps {
  fetchImpl?: typeof fetch;
}

export const ArchivePage: FC<MagazineArchiveProps> = (props) => {
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const [view, setView] = useState<ArchiveView>({ phase: "loading", archive: [], issueCount: 0 });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await doFetch("/api/me/issues");
        if (!alive) return;
        if (res.status === 401) {
          setView({ phase: "signed-out", archive: [], issueCount: 0 });
          return;
        }
        if (!res.ok) {
          setView({ phase: "failed", archive: [], issueCount: 0 });
          return;
        }
        const body = (await res.json()) as { archive?: ArchiveEntryRow[]; issueCount?: number };
        setView({
          phase: "ready",
          archive: Array.isArray(body.archive) ? body.archive : [],
          issueCount: Number(body.issueCount ?? 0),
        });
      } catch {
        if (alive) setView({ phase: "failed", archive: [], issueCount: 0 });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let body: ReactElement;
  if (view.phase === "loading") {
    body = createElement("p", { role: "status", className: "mag-note" }, "正在翻往期……");
  } else if (view.phase === "signed-out") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, MAGAZINE_COPY.signedOut),
      createElement("a", { href: "/login", className: "e-cta" }, MAGAZINE_COPY.goToLogin),
    );
  } else if (view.phase === "failed") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, MAGAZINE_COPY.failed),
    );
  } else if (!view.archive.length) {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, "还没有往期"),
      createElement("div", { className: "e-s" }, "每天出一期，过几天这里就会有一张一张的回看。"),
      createElement("a", { href: "/", className: "e-cta mt-4" }, "看今天的"),
    );
  } else {
    const rows = archiveRows(view.archive);
    body = createElement("div", { className: "arch-list" },
      rows.map((row) =>
        createElement("a", { key: row.date, href: `/issue/${row.date}`, className: "arch-item" },
          createElement("div", { className: "arch-date" }, row.label),
          createElement("div", { className: "arch-sub" }, row.sub),
          createElement("div", { className: "arch-titles" }, row.titles.slice(0, 3).join(" · ")),
        ),
      ),
    );
  }

  return createElement("div", { className: "magazine mx-auto w-full max-w-[560px] px-4 py-6" },
    createElement("div", { className: "mag-masthead" },
      createElement("div", { className: "mag-masthead-row" },
        createElement("div", { className: "mag-date" }, "往期"),
        createElement("div", { className: "mag-issue" },
          view.phase === "ready" && view.issueCount > 0
            ? createElement("div", { className: "mag-proj" }, `共 ${view.issueCount} 期`)
            : null,
        ),
      ),
      createElement("div", { className: "mag-rule" }),
    ),
    body,
    createElement("div", { className: "mag-foot" },
      createElement("div", { className: "f-row" },
        createElement("a", { className: "f-a hit", href: "/" }, "回今日"),
      ),
    ),
  );
};
