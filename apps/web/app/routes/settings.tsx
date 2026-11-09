// 设置: thin shell around features/settings/settings.
import { SITE } from "@topka/industry/site";
import { useNavigate } from "react-router";
import type { Route } from "./+types/settings";
import { pageMeta } from "../lib/seo";
import { SettingsPage } from "../features/settings/settings";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "设置", description: `账号、自带模型 Key 与项目：${SITE.name}。`, path: "/settings", noindex: true });

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function SettingsRoute() {
  const navigate = useNavigate();
  return <SettingsPage onDeleted={() => navigate("/login", { replace: true })} />;
}
