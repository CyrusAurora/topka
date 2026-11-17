// The discovery channels page: a thin shell around the .ts factory (features/discover).
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/discover";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { DiscoverPage } from "../features/discover/discover-view";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.discover.metaTitle, description: t.discover.metaDescription(SITE.name), path: "/discover", noindex: true, locale });
};

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function DiscoverRoute() {
  return <DiscoverPage />;
}
