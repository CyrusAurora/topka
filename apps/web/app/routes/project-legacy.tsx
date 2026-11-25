// /today/:projectId was a project's page until it moved under /projects; links already sent keep
// working through a permanent redirect (query and fragment kept by the browser).
import { redirect } from "react-router";
import type { Route } from "./+types/project-legacy";

export function loader({ params, request }: Route.LoaderArgs) {
  const search = new URL(request.url).search;
  throw redirect(`/projects/${encodeURIComponent(params.projectId)}${search}`, 301);
}

export default function ProjectLegacy() {
  return null;
}
