// The magazine's single-issue reader (往期 → 单期), /issue/:date. Same card chrome as 今日
// (features/magazine/today.ts): masthead with the issue's own day and number, the cards, expand in
// place, copy the link. Reads GET /api/me/issues/:date; expanding POSTs /api/me/issues/read like
// 今日 does.
// The endpoint answers { issue } only (no opened/projects), so the read marks come back empty and
// the project label is what the issue's own items carry.
import { createElement, useState, type FC, type ReactElement } from "react";
import { bodyOf, phaseOf, useReaderData, type Responses } from "../../lib/reader-data.ts";
import { failedEl, magPage, mastheadEl, signedOutEl, skeletonRows } from "./states.ts";
import { useT, useUiPrefs } from "../../lib/i18n.ts";
import { issueRows, type IssueCard } from "./view.ts";
import { cardList, useCardState } from "./cards.ts";

export interface MagazineIssueProps {
  date: string;
  fetchImpl?: typeof fetch;
}

type Phase = "loading" | "signed-out" | "not-found" | "failed" | "ready";

interface IssueState {
  phase: Phase;
  issue: IssueCard | null;
  contentLang?: string;
}

/** The page's one GET. */
export function issuePaths(date: string): string[] {
  return [`/api/me/issues/${encodeURIComponent(date)}`];
}

/** The single issue's state from the answer (null: not here yet). */
export function issueStateOf(data: Responses | null, path: string): IssueState {
  if (!data) return { phase: "loading", issue: null };
  const got = data[path];
  if (got?.status === 404) return { phase: "not-found", issue: null };
  const phase = phaseOf(got);
  if (phase !== "ready") return { phase, issue: null };
  const body = bodyOf<{ issue?: IssueCard | null; contentLang?: string }>(got);
  return body?.issue ? { phase: "ready", issue: body.issue, contentLang: body.contentLang } : { phase: "not-found", issue: null };
}

export const MagazineIssue: FC<MagazineIssueProps> = (props) => {
  const t = useT();
  const { locale, timeZone } = useUiPrefs();
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const path = issuePaths(props.date)[0]!;
  const { data } = useReaderData(issuePaths(props.date), props.fetchImpl);
  const state = issueStateOf(data, path);
  const cards = useCardState(doFetch);
  // Another day in the same mounted page: nothing stays open or copied.
  const [shownDate, setShownDate] = useState(props.date);
  if (shownDate !== props.date) {
    setShownDate(props.date);
    cards.reset();
  }

  const back = { href: "/archive", label: t.magazine.backToArchive };
  const issue = state.issue;
  const day = issue?.date ?? props.date;
  const foot = createElement("div", { className: "mag-foot" },
    createElement("div", { className: "f-row" },
      createElement("a", { className: "f-a hit", href: "/archive" }, t.magazine.backToArchive),
    ),
  );

  if (state.phase === "loading") return magPage({ head: mastheadEl(day, locale), body: skeletonRows(t.magazine.issueLoading) });
  if (state.phase === "signed-out") return magPage({ head: mastheadEl(day, locale), body: signedOutEl(t) });
  if (state.phase === "not-found") {
    return magPage({
      head: mastheadEl(day, locale),
      body: createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, t.magazine.notFoundTitle),
        createElement("div", { className: "e-s" }, t.magazine.notFoundSub),
        createElement("a", { href: "/archive", className: "e-cta mt-4" }, t.magazine.backToArchive),
      ),
    });
  }
  if (state.phase === "failed" || !issue) return magPage({ head: mastheadEl(day, locale), body: failedEl(t, back) });

  const multi = new Set(issue.items.map((i) => i.project.id)).size > 1;
  const rows = issueRows(issue, { multi, locale, timeZone });
  const body: ReactElement = rows.length === 0
    ? createElement("div", { className: "mag-empty" },
        createElement("div", { className: "e-t" }, t.magazine.emptyIssueTitle),
        createElement("div", { className: "e-s" }, t.magazine.emptyIssueSub),
      )
    : cardList({ rows, state: cards, t, locale, contentLang: state.contentLang, hero: issue.hero === true });
  const right = createElement("div", { className: "mag-no" }, issue.no ? `No. ${String(issue.no).padStart(3, "0")}` : "");
  return magPage({ head: mastheadEl(issue.date, locale, right), body, foot });
};
