// Magazine 今日: thin shell around features/magazine/today (node --test cannot load JSX).
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/magazine-today";
import { pageMeta } from "../lib/seo";
import { messages, localeOf } from "../lib/i18n";
import { MagazineToday } from "../features/magazine/today";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.magazine.today, description: t.magazine.todayMetaDescription(SITE.name), path: "/", locale });
};

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function MagazineTodayRoute() {
  return <MagazineToday />;
}
