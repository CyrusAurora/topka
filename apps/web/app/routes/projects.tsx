// 项目: the reader's projects (features/projects/overview), rendered on the server.
import { SITE } from "@topka/industry/site";
import { readerLoader } from "../lib/reader.server";
import { noStore, ReaderData } from "../components/shell/ReaderData";
import type { Route } from "./+types/projects";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { PROJECTS_PATH, ProjectsOverview } from "../features/projects/overview";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.projects.meta.overviewTitle, description: t.projects.meta.overviewDescription(SITE.name), path: "/projects", noindex: true, locale });
};

export const headers = noStore;

export const loader = readerLoader(() => [PROJECTS_PATH]);

export default function ProjectsPage() {
  return (
    <ReaderData>
      <ProjectsOverview />
    </ReaderData>
  );
}
