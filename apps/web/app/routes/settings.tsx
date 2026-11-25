// 设置: thin shell around features/settings/settings.
import { SITE } from "@topka/industry/site";
import { useNavigate } from "react-router";
import { readerLoader } from "../lib/reader.server";
import { noStore, ReaderData } from "../components/shell/ReaderData";
import type { Route } from "./+types/settings";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { SETTINGS_PATHS, SettingsPage } from "../features/settings/settings";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.settings.metaTitle, description: t.settings.metaDescription(SITE.name), path: "/settings", noindex: true, locale });
};

export const headers = noStore;

export const loader = readerLoader(() => SETTINGS_PATHS);

export default function SettingsRoute() {
  const navigate = useNavigate();
  return (
    <ReaderData>
      <SettingsPage onDeleted={() => navigate("/login", { replace: true })} />
    </ReaderData>
  );
}
