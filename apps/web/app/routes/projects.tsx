// The project overview route: a thin shell around the .ts overview factory (the component tests run
// under node --test, which cannot load JSX).
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/projects";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { ProjectsOverview } from "../features/projects/overview";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.projects.meta.overviewTitle, description: t.projects.meta.overviewDescription(SITE.name), path: "/projects", noindex: true, locale });
};

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function ProjectsPage() {
  return <ProjectsOverview />;
}
