// The magazine's 今日 page (master design B1): masthead, the fixed 3 cards, expand in place, copy
// the original link, 往期 in the footer. A plain .ts factory for the node --test component tests;
// the route file is a thin shell around it. Reads /api/me/today (lib/reader-data.ts: rendered on the
// server with the reader's session, fetched in the browser otherwise); a single issue reader reuses
// the same card list.
import { createElement, type FC, type ReactElement } from "react";
import { cardList, useCardState } from "./cards.ts";
import { bodyOf, phaseOf, useReaderData } from "../../lib/reader-data.ts";
import { issueDayIn } from "../../lib/issue-day.ts";
import { useT, useUiPrefs } from "../../lib/i18n.ts";
import { failedEl, magPage, mastheadEl, signedOutEl, skeletonRows } from "./states.ts";
import {
  cardRows,
  contentLangAttr,
  projectLabelOf,
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
    contentLang: payload.contentLang,
    footNote: payload.footNote,
  };
}

/** The page's one GET. */
export const TODAY_PATHS = ["/api/me/today"] as const;

export const MagazineToday: FC<MagazineTodayProps> = (props) => {
  const t = useT();
  const { locale, timeZone } = useUiPrefs();
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const { data } = useReaderData(TODAY_PATHS, props.fetchImpl);
  const got = data?.["/api/me/today"];
  const phase: Phase = !data ? "loading" : phaseOf(got);
  const payload = bodyOf<MagazineIssuePayload>(got);
  const state = { phase, view: payload ? viewOf(payload) : null };
  const cards = useCardState(doFetch);
  const v = state.view;

  // The masthead's day: the issue's own date when it is there; otherwise the issue day in the
  // reader's time zone (not the browser's or the server's calendar).
  const day = state.view?.issue?.date ?? issueDayIn(new Date(), timeZone);
  if (state.phase === "loading") return magPage({ head: mastheadEl(day, locale), body: skeletonRows(t.magazine.loading) });
  if (state.phase === "signed-out") return magPage({ head: mastheadEl(day, locale), body: signedOutEl(t) });
  if (state.phase === "failed" || !v) return magPage({ head: mastheadEl(day, locale), body: failedEl(t) });

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
    body = cardList({ rows, state: cards, t, locale, contentLang: v.contentLang, muteLinks: true });
  }

  const right = [
    createElement("div", { key: "no", className: "mag-no" }, v.issue?.no ? `No. ${String(v.issue.no).padStart(3, "0")}` : ""),
    createElement("div", { key: "proj", className: "mag-proj", lang: v.projects.length === 1 ? contentLangAttr(v.contentLang, locale, v.projects[0]!.target) : undefined }, projectLabelOf(v.projects, locale)),
  ];
  return createElement("div", { className: "magazine mag-page" },
    mastheadEl(day, locale, right),
    body,
    createElement("div", { className: "mag-foot" },
      createElement("div", { className: "f-row" },
        createElement("span", { className: "f-l" }, v.footNote || t.magazine.updateEveryMorning),
        createElement("span", { className: "f-r" },
          createElement("a", { className: "f-a hit", href: "/archive" }, t.magazine.archive),
          createElement("a", { className: "f-a acc hit", href: "/settings#reminder", "data-remind": "" }, t.magazine.remindMe),
        ),
      ),
    ),
  );
};

