// A project's own page (/projects/:projectId): its cards for today, the brief and its sources
// (features/today/today-view), rendered on the server.
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/project";
import { pageMeta } from "../lib/seo";
import { messages, localeOf } from "../lib/i18n";
import { projectTodayPaths, TodayPage } from "../features/today/today-view";
import { readerLoader } from "../lib/reader.server";
import { noStore, ReaderData } from "../components/shell/ReaderData";

export const meta: Route.MetaFunction = ({ params, matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.today.title, description: t.today.metaDescription(SITE.name), path: `/projects/${params.projectId}`, noindex: true, locale });
};

export const headers = noStore;

export const loader = readerLoader(({ params }) => projectTodayPaths(params.projectId ?? ""));

export default function ProjectRoute({ params }: Route.ComponentProps) {
  return (
    <ReaderData>
      <TodayPage projectId={params.projectId} />
    </ReaderData>
  );
}
