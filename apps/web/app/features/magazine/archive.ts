// The magazine's 往期 list (master design B2): the reader's past issues, newest first, from
// GET /api/me/issues — one line per day with the day's issue number and its titles, tapping a
// row reads that day (GET /api/me/issues/:date). Same page shell as 今日, a thin card list.
import { createElement, useEffect, useState, type FC, type ReactElement } from "react";
import { useT, useUiPrefs } from "../../lib/i18n.ts";
import { archiveRows } from "./view.ts";

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
  const t = useT();
  const { locale } = useUiPrefs();
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
    body = createElement("p", { role: "status", className: "mag-note" }, t.magazine.archiveLoading);
  } else if (view.phase === "signed-out") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, t.magazine.signedOut),
      createElement("a", { href: "/login", className: "e-cta" }, t.magazine.goToLogin),
    );
  } else if (view.phase === "failed") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, t.magazine.failed),
    );
  } else if (!view.archive.length) {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, t.magazine.archiveEmptyTitle),
      createElement("div", { className: "e-s" }, t.magazine.archiveEmptySub),
      createElement("a", { href: "/", className: "e-cta mt-4" }, t.magazine.archiveEmptyCta),
    );
  } else {
    const rows = archiveRows(view.archive, locale);
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
        createElement("div", { className: "mag-date" }, t.magazine.archive),
        createElement("div", { className: "mag-issue" },
          view.phase === "ready" && view.issueCount > 0
            ? createElement("div", { className: "mag-proj" }, t.magazine.archiveCount(view.issueCount))
            : null,
        ),
      ),
      createElement("div", { className: "mag-rule" }),
    ),
    body,
    createElement("div", { className: "mag-foot" },
      createElement("div", { className: "f-row" },
        createElement("a", { className: "f-a hit", href: "/" }, t.magazine.backToday),
      ),
    ),
  );
};
