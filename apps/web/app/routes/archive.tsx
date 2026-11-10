// Magazine 往期 list: thin shell around features/magazine/archive.
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/archive";
import { pageMeta } from "../lib/seo";
import { messages, localeOf } from "../lib/i18n";
import { ArchivePage } from "../features/magazine/archive";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.magazine.archive, description: t.magazine.archiveMetaDescription(SITE.name), path: "/archive", noindex: true, locale });
};

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function ArchiveRoute() {
  return <ArchivePage />;
}
