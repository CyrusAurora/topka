// The guided creation route: a thin shell around the .ts wizard factory (the component tests run
// under node --test, which cannot load JSX).
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/projects-new";
import { pageMeta } from "../lib/seo";
import { GuidedCreation } from "../features/projects/guided-creation";

export const meta: Route.MetaFunction = () => pageMeta({ title: "新建追踪项目", description: `选一个策展包开始盯：选包、挑来源、起个名，${SITE.name} 建好项目就开始持续跟踪。`, path: "/projects/new", noindex: true });

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function ProjectsNewPage() {
  return <GuidedCreation />;
}
