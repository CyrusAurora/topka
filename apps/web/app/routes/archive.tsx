// Magazine 往期 list: thin shell around features/magazine/archive.
import { SITE } from "@topka/industry/site";
import type { Route } from "./+types/archive";
import { pageMeta } from "../lib/seo";
import { ArchivePage } from "../features/magazine/archive";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "往期", description: `翻看往日的今日三卡：${SITE.name}。`, path: "/archive", noindex: true });

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function ArchiveRoute() {
  return <ArchivePage />;
}
