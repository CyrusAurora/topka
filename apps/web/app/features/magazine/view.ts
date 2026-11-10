// The magazine's card chrome (今日 / 往期 / 单期), one place for the view-model of a fixed daily issue:
// masthead date + weekday + issue no, the up-to-three cards, read/expand state and footer, as on the
// mobile 今日 page. Plain functions so the node --test harness can check the card text, the
// "no score on the cards" rule and the honest empty states without a DOM.
// Backend: GET /api/me/today (UserIssuePayload) and GET /api/me/issues (archive). No model call here —
// everything the reader sees was fixed at 08:00 UTC+8.

import { messages, type UiLocale } from "../../lib/i18n.ts";

/** The card shape every issue carries (UserIssuePayload.issue). */
export interface IssueCardItem {
  id: string;
  position: number;
  title_a: string;
  title_b: string;
  core_a: string;
  core_b: string;
  summary: string;
  tag: string;
  source: string;
  url: string;
  /** Internal only — never rendered on the user-facing cards. */
  score: number | null;
  project: { id: string; slug: string; target: string };
  publishedAt: string | null;
  listedAt: string;
  hasCopy: boolean;
  overBudget: boolean;
}

export interface IssueCard {
  date: string;
  no: number | null;
  fixedAt: string;
  hero: boolean;
  ready: boolean;
  items: IssueCardItem[];
}

export interface MagazineProject {
  id: string;
  slug: string;
  target: string;
}

export interface MagazineIssuePayload {
  schemaVersion?: number;
  user?: { id: string };
  projects: MagazineProject[];
  generatedAt?: string;
  nextAt?: string;
  issueCount?: number;
  issue: IssueCard | null;
  opened?: string[];
  archive?: Array<{ date: string; no: number; titles: string[] }>;
  notice?: string;
}

/** Calendar day in the server's own time zone, the day the masthead shows. */
export const issueDayOf = (payload: Pick<MagazineIssuePayload, "issue">): string =>
  payload.issue?.date ?? new Date().toISOString().slice(0, 10);

/** Calendar parts of an instant in a time zone. */
function partsIn(ms: number, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day") };
}
const dayIndex = (ms: number, timeZone: string) => {
  const { y, m, d } = partsIn(ms, timeZone);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400e3);
};

/** "2026.10.27" + "周一", masthead style. */
export function masthead(date: string, locale: UiLocale = "zh-CN"): { date: string; weekday: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekdays = messages(locale).magazine.weekdayShort;
  return { date: `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`, weekday: weekdays[d.getUTCDay()] ?? weekdays[1]! };
}

/** "No. 007"; an empty day (no issue_no) gets no number at all. */
export const issueNo = (no: number | null | undefined): string => (no ? `No. ${String(no).padStart(3, "0")}` : "");

/** The projects the masthead's right column names: one project → its name, several → the count. */
export function projectLabelOf(projects: MagazineProject[], locale: UiLocale = "zh-CN"): string {
  if (projects.length === 1) return projects[0]!.target;
  if (projects.length > 1) return messages(locale).magazine.projectsCount(projects.length);
  return "";
}

/** An item's line under the card: source · time, and the project when several are tracked. */
export function cardMeta(item: Pick<IssueCardItem, "source" | "publishedAt" | "listedAt" | "project">, multi: boolean, now: Date = new Date(), locale: UiLocale = "zh-CN", timeZone: string = "Asia/Shanghai"): string {
  const source = item.source || messages(locale).magazine.unknownSource;
  const when = relTime(item.publishedAt ?? item.listedAt, now, locale, timeZone);
  const parts = [`${source} · ${when}`];
  if (multi) parts.push(item.project.target);
  return parts.join(" · ");
}

/** The expand pane's time line: host of the link, and the absolute time when the reader opened it. */
export function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(String(url ?? ""));
  return m ? m[1].replace(/^www\./i, "").toLowerCase() : "";
}

/** "今天 / 昨天 / N 天前 / M月D日" (or the English equivalent) relative to now, in the given time zone. */
export function relTime(iso: string | null, now: Date = new Date(), locale: UiLocale = "zh-CN", timeZone: string = "Asia/Shanghai"): string {
  if (!iso) return "";
  const t = messages(locale);
  const diff = dayIndex(now.getTime(), timeZone) - dayIndex(Date.parse(iso), timeZone);
  if (diff <= 0) return t.magazine.relToday;
  if (diff === 1) return t.magazine.relYesterday;
  if (diff <= 6) return t.magazine.daysAgo(diff);
  const { m, d } = partsIn(Date.parse(iso), timeZone);
  return t.common.monthDay(m, d);
}

export type MagazinePhase = "loading" | "signed-out" | "first" | "preparing" | "zero" | "ready" | "failed";

/** What 今日 shows: the issue, its honest empty states, or the sign-in request. */
export interface TodayView {
  phase: MagazinePhase;
  /** The day the masthead names, even before the issue arrives (the loading skeleton). */
  day: string;
  projects: MagazineProject[];
  issue: IssueCard | null;
  /** Read marks the server has seen, unioned with this client's own opens. */
  opened: string[];
  archive: Array<{ date: string; no: number; titles: string[] }>;
  notice: string;
}

/** The card the page renders. Scores are deliberately absent from this shape: the rule is enforced
 *  at the view-model, not by remembering not to print them. */
export interface CardRow {
  id: string;
  no: string;
  title: string;
  /** core_a and core_b read as one line; both empty reads as nothing under the title. */
  core: string;
  source: string;
  when: string;
  project: string;
  multi: boolean;
  url: string;
  host: string;
  summary: string;
  /** Topic tag for 「不想再看到这类」; empty hides the mute link. */
  tag: string;
  read: boolean;
}

export function cardRows(view: TodayView, now: Date = new Date(), locale: UiLocale = "zh-CN", timeZone: string = "Asia/Shanghai"): CardRow[] {
  const issue = view.issue;
  if (!issue || !issue.items.length) return [];
  const multi = view.projects.length > 1;
  return issue.items.map((item) => ({
    id: item.id,
    no: String(item.position).padStart(2, "0"),
    title: [item.title_a, item.title_b].filter(Boolean).join(" "),
    core: [item.core_a, item.core_b].filter(Boolean).join(" "),
    source: item.source,
    when: relTime(item.publishedAt ?? item.listedAt, now, locale, timeZone),
    project: multi ? item.project.target : "",
    multi,
    url: item.url,
    host: hostOf(item.url),
    summary: item.summary,
    tag: item.tag,
    read: view.opened.includes(item.id),
  }));
}

export interface ArchiveEntryRow {
  date: string;
  no: number;
  titles: string[];
}

/** 往期's rows: one line per past day, with the day's titles as the preview. */
export function archiveRows(archive: ArchiveEntryRow[], locale: UiLocale = "zh-CN"): Array<{ date: string; label: string; sub: string; titles: string[] }> {
  const t = messages(locale);
  return archive.map((a) => {
    const { weekday } = masthead(a.date, locale);
    // The label comes from the ISO day itself. (`masthead` returns the dotted "11.04" form, which is a
    // masthead, not a parseable "month.day" pair: reading it with /^(\d+)\.(\d+)$/ yields one match,
    // and mapping the match array gives "11.04月11日".)
    const [, m, d] = a.date.split("-");
    const no = issueNo(a.no);
    return {
      date: a.date,
      label: t.common.monthDay(Number(m), Number(d)),
      sub: no ? `${weekday} · ${no}` : weekday,
      titles: a.titles,
    };
  });
}
