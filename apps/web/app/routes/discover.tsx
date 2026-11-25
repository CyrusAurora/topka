// The discovery channels page: a thin shell around the .ts factory (features/discover).
import { SITE } from "@topka/industry/site";
import { readerLoader } from "../lib/reader.server";
import { noStore, ReaderData } from "../components/shell/ReaderData";
import type { Route } from "./+types/discover";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { DISCOVER_PATH, DiscoverPage } from "../features/discover/discover-view";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.discover.metaTitle, description: t.discover.metaDescription(SITE.name), path: "/discover", noindex: true, locale });
};

export const headers = noStore;

export const loader = readerLoader(() => [DISCOVER_PATH]);

export default function DiscoverRoute() {
  return (
    <ReaderData>
      <DiscoverPage />
    </ReaderData>
  );
}
