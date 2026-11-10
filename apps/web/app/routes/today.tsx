// The per-project today reading view: a thin shell around the .ts factory (features/today).
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/today";
import { pageMeta } from "../lib/seo";
import { messages, localeOf } from "../lib/i18n";
import { TodayPage } from "../features/today/today-view";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.today.title, description: t.today.metaDescription(SITE.name), path: "/today", noindex: true, locale });
};

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function TodayRoute({ params }: Route.ComponentProps) {
  return <TodayPage projectId={params.projectId} />;
}
