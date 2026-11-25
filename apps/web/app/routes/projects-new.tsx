// 新建项目: the guided creation (features/projects/guided-creation), rendered on the server.
import { SITE } from "@topka/industry/site";
import { readerLoader } from "../lib/reader.server";
import { noStore, ReaderData } from "../components/shell/ReaderData";
import type { Route } from "./+types/projects-new";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { GuidedCreation, WIZARD_PATHS } from "../features/projects/guided-creation";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.projects.meta.newTitle, description: t.projects.meta.newDescription(SITE.name), path: "/projects/new", noindex: true, locale });
};

export const headers = noStore;

export const loader = readerLoader(() => WIZARD_PATHS);

export default function ProjectsNewPage() {
  return (
    <ReaderData>
      <GuidedCreation />
    </ReaderData>
  );
}
