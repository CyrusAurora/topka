// Magazine 今日: thin shell around features/magazine/today (node --test cannot load JSX).
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/magazine-today";
import { pageMeta } from "../lib/seo";
import { MagazineToday } from "../features/magazine/today";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "今日", description: `每天 3 件最该知道的事：${SITE.name} 杂志风今日。`, path: "/" });

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function MagazineTodayRoute() {
  return <MagazineToday />;
}
