// Magazine single-issue reader: thin shell around features/magazine/issue-view.
import { data } from "react-router";
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/issue";
import { pageMeta } from "../lib/seo";
import { MagazineIssue } from "../features/magazine/issue-view";

export const meta: Route.MetaFunction = ({ params }) =>
  pageMeta({
    title: `第 ${params.date} 期`,
    description: `${SITE.name} ${params.date} 的今日三卡。`,
    path: `/issue/${params.date}`,
    noindex: true,
  });

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
