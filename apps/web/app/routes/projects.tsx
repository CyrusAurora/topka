// The project overview route: a thin shell around the .ts overview factory (the component tests run
// under node --test, which cannot load JSX).
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/projects";
import { pageMeta } from "../lib/seo";
import { ProjectsOverview } from "../features/projects/overview";

export const meta: Route.MetaFunction = () => pageMeta({ title: "项目", description: `你的追踪项目总览：${SITE.name} 里你正在盯的方向和它们的更新。`, path: "/projects", noindex: true });

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function ProjectsPage() {
  return <ProjectsOverview />;
}
