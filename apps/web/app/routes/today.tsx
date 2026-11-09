// The per-project today reading view: a thin shell around the .ts factory (features/today).
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/today";
import { pageMeta } from "../lib/seo";
import { TodayPage } from "../features/today/today-view";

export const meta: Route.MetaFunction = () => pageMeta({ title: "今日", description: `${SITE.name} 项目的今日更新。`, path: "/today", noindex: true });

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function TodayRoute({ params }: Route.ComponentProps) {
  return <TodayPage projectId={params.projectId} />;
}
