// Magazine single-issue reader: thin shell around features/magazine/issue-view.
import { data } from "react-router";
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/issue";
import { pageMeta } from "../lib/seo";
import { messages, localeOf } from "../lib/i18n";
import { MagazineIssue } from "../features/magazine/issue-view";

export const meta: Route.MetaFunction = ({ params, matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  const date = params.date;
  return pageMeta({
    title: t.magazine.issueMetaTitle(date),
    description: t.magazine.issueMetaDescription(SITE.name, date),
    path: `/issue/${date}`,
    noindex: true,
    locale,
  });
};

/** A real calendar day as YYYY-MM-DD; anything else is the 404 page, not an empty issue. */
export function isIssueDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function loader({ params }: Route.LoaderArgs) {
  if (!isIssueDate(params.date)) throw data(null, { status: 404 });
  return null;
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function IssueRoute({ params }: Route.ComponentProps) {
  return <MagazineIssue date={params.date} />;
}
