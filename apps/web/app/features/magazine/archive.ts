// The magazine's 往期 list (master design B2): the reader's past issues, newest first, from
// GET /api/me/issues — one line per day with the day's issue number and its titles, tapping a
// row reads that day (GET /api/me/issues/:date). Same page shell as 今日, a thin card list.
import { createElement, type FC, type ReactElement } from "react";
import { bodyOf, phaseOf, useReaderData, type Responses } from "../../lib/reader-data.ts";
import { failedEl, signedOutEl, skeletonRows } from "./states.ts";
import { useT, useUiPrefs } from "../../lib/i18n.ts";
import { archiveRows, contentLangAttr } from "./view.ts";

export interface ArchiveEntryRow {
  date: string;
  no: number;
  titles: string[];
}

export interface ArchiveView {
  phase: "loading" | "signed-out" | "failed" | "ready";
  archive: ArchiveEntryRow[];
  issueCount: number;
  contentLang?: string;
}

/** The page's one GET. */
export const ARCHIVE_PATHS = ["/api/me/issues"] as const;

/** 往期's view from the answer (null: not here yet). */
export function archiveViewOf(data: Responses | null): ArchiveView {
  if (!data) return { phase: "loading", archive: [], issueCount: 0 };
  const got = data["/api/me/issues"];
  const phase = phaseOf(got);
  const body = bodyOf<{ archive?: ArchiveEntryRow[]; issueCount?: number; contentLang?: string }>(got);
  if (phase !== "ready" || !body) return { phase: phase === "ready" ? "failed" : phase, archive: [], issueCount: 0 };
  return { phase: "ready", archive: Array.isArray(body.archive) ? body.archive : [], issueCount: Number(body.issueCount ?? 0), contentLang: body.contentLang };
}

export interface MagazineArchiveProps {
  fetchImpl?: typeof fetch;
}

export const ArchivePage: FC<MagazineArchiveProps> = (props) => {
  const t = useT();
  const { locale } = useUiPrefs();
  const { data } = useReaderData(ARCHIVE_PATHS, props.fetchImpl);
  const view = archiveViewOf(data);

  let body: ReactElement;
  if (view.phase === "loading") {
    body = skeletonRows(t.magazine.archiveLoading);
  } else if (view.phase === "signed-out") {
    body = signedOutEl(t);
  } else if (view.phase === "failed") {
    body = failedEl(t);
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
          createElement("div", { className: "arch-titles", lang: contentLangAttr(view.contentLang, locale, row.titles.slice(0, 3).join(" · ")) }, row.titles.slice(0, 3).join(" · ")),
        ),
      ),
    );
  }

  return createElement("div", { className: "magazine mag-page" },
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
