// The guided creation route: a thin shell around the .ts wizard factory (the component tests run
// under node --test, which cannot load JSX).
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/projects-new";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { GuidedCreation } from "../features/projects/guided-creation";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.projects.meta.newTitle, description: t.projects.meta.newDescription(SITE.name), path: "/projects/new", noindex: true, locale });
};

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function ProjectsNewPage() {
  return <GuidedCreation />;
}
