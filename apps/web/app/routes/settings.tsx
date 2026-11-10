// 设置: thin shell around features/settings/settings.
import { SITE } from "@topka/industry/site";
import { useNavigate } from "react-router";
import type { Route } from "./+types/settings";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { SettingsPage } from "../features/settings/settings";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.settings.metaTitle, description: t.settings.metaDescription(SITE.name), path: "/settings", noindex: true, locale });
};

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function SettingsRoute() {
  const navigate = useNavigate();
  return <SettingsPage onDeleted={() => navigate("/login", { replace: true })} />;
}
