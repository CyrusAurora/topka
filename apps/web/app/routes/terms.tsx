import { SITE } from "@topka/industry/site";
import { data } from "react-router";
import type { Route } from "./+types/terms";
import { pageMeta } from "../lib/seo";
import { prepareCopy } from "../lib/site-copy";
import { localeOf, messages, useLocale } from "../lib/i18n";
import zhCopy from "@topka/industry/pages/terms.md?raw";
import enCopy from "@topka/industry/pages/terms.en.md?raw";
import { CopyPage, docFact, LegalFooterLinks } from "../features/copy/CopyPage";

const COPY = { "zh-CN": prepareCopy(zhCopy), en: prepareCopy(enCopy) };

/** Off (SITE.legalPages false): the page is a 404 and nothing links to it; the copy stays for later. */
export function loader() {
  if (!SITE.legalPages) throw data(null, { status: 404 });
  return null;
}

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale).legal;
  return pageMeta({ title: t.terms, description: t.termsDescription, path: "/terms", image: "/og/pages/terms.png", locale });
};

export default function TermsPage() {
  const locale = useLocale();
  const t = messages(locale).legal;
  const page = COPY[locale];
  return (
    <CopyPage
      doc={page.doc}
      rendered={page.rendered}
      eyebrow={SITE.name}
      footer={<LegalFooterLinks links={[{ to: "/privacy", label: t.privacy }, { to: "/agent", label: t.agent }]} note={`${t.terms} ${docFact(page.doc, "version") ?? ""} · ${docFact(page.doc, "effective") ?? ""}`} />}
    />
  );
}
