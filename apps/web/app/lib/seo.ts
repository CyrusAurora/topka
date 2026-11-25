// Page metadata from one place: title template, canonical address, OG images, robots. The site's name
// and wording come from the industry pack (industry/site.ts); its address from SITE_URL.
import type { MetaDescriptor } from "react-router";
import { SITE, siteCopy } from "@topka/industry/site";
import { siteAddress } from "@topka/contracts/address";
import type { UiLocale } from "./i18n.ts";

/**
 * The site's address: SITE_URL (or the address PORT implies) while rendering on the server (what crawlers and share previews read),
 * the page's own origin in the browser.
 */
export function siteUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return siteAddress(process.env, SITE.defaultUrl);
}

/** Open Graph locale names for the UI locales. */
const OG_LOCALE: Record<UiLocale, string> = { "zh-CN": "zh_CN", en: "en_US" };

export interface PageMetaInput {
  title?: string | null;
  /** Use `title` verbatim as the document title (no " · <site>" suffix). */
  rawTitle?: boolean;
  description?: string | null;
  path: string;
  image?: string | null;
  noindex?: boolean;
  nofollow?: boolean;
  type?: "website" | "article";
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
  /** The page's UI locale (the root loader's); picks the site copy and og:locale. Defaults to SITE.locale. */
  locale?: UiLocale;
}

/** "Title · Site". */
export function titled(title: string): string {
  return `${title} · ${SITE.name}`;
}

export function pageMeta(input: PageMetaInput): MetaDescriptor[] {
  const base = siteUrl();
  const locale: UiLocale = input.locale ?? ((SITE.locale as string) === "en" ? "en" : "zh-CN");
  const copy = siteCopy(locale);
  const title = input.title ? (input.rawTitle ? input.title : titled(input.title)) : copy.homeTitle;
  const description = input.description ?? copy.description;
  const url = `${base}${input.path}`;
  const image = input.image ? (input.image.startsWith("http") ? input.image : `${base}${input.image}`) : `${base}/og/site.png`;
  const tags: MetaDescriptor[] = [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:site_name", content: SITE.name },
    { property: "og:type", content: input.type ?? "website" },
    { property: "og:title", content: input.title ?? copy.homeTitle },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:locale", content: OG_LOCALE[locale] },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: input.title ?? copy.homeTitle },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
  if (input.noindex) tags.push({ name: "robots", content: input.nofollow ? "noindex, nofollow" : "noindex, follow" });
  if (input.jsonLd) tags.push({ "script:ld+json": input.jsonLd });
  return tags;
}

export function organizationLd() {
  const base = siteUrl();
  const founder = SITE.organization.founder;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.organization.name,
    url: base,
    logo: `${base}/icon.png`,
    ...(founder ? { founder: { "@type": "Person", name: founder.name, ...(founder.description ? { description: founder.description } : {}), ...(founder.url ? { sameAs: [founder.url] } : {}) } } : {}),
  };
}
