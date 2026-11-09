// Retired Topka pages: a permanent redirect to 今日 or 往期 (lib/legacy-paths.ts).
import { redirect } from "react-router";
import type { Route } from "./+types/legacy";
import { legacyTarget } from "../lib/legacy-paths";

export function loader({ request }: Route.LoaderArgs) {
  throw redirect(legacyTarget(new URL(request.url).pathname), 301);
}

export default function Legacy() {
  return null;
}
