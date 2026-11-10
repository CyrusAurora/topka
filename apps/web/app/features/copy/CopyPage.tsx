import type { ReactNode } from "react";
import { Link } from "react-router";
import type { CopyDocument, RenderedCopy } from "../../lib/markdown";
import { ArticleLayout, RailSection } from "../../components/ui/Page";
import { useT } from "../../lib/i18n";

/** The document facts the rail shows, by the key each copy file uses in its table (Chinese or English). */
const FACT_KEYS = [
  ["version", ["版本", "Version"]], // i18n-data: keys as written in industry/pages/*.md
  ["effective", ["生效日期", "Effective date"]], // i18n-data
  ["operator", ["运营主体", "Operator"]], // i18n-data
  ["icp", ["备案号", "ICP filing"]], // i18n-data
] as const;

/** A fact from the document's table, whichever language the file is written in. */
export function docFact(doc: CopyDocument, fact: (typeof FACT_KEYS)[number][0]): string | null {
  const keys = FACT_KEYS.find(([k]) => k === fact)![1];
  for (const k of keys) if (doc.meta[k]) return doc.meta[k]!;
  return null;
}

/**
 * Legal and policy pages, read like articles: the document on the page in one column, its facts in the
 * left rail and its outline in the right (phones get the facts above the text and no outline).
 */
export function CopyPage({ doc, rendered, eyebrow, footer, aside }: { doc: CopyDocument; rendered: RenderedCopy; eyebrow?: ReactNode; footer?: ReactNode; aside?: ReactNode }) {
  const t = useT().legal;
  const facts = FACT_KEYS.map(([k]) => ({ k, label: t.facts[k], value: docFact(doc, k) })).filter((f) => f.value);
  const info = facts.length > 0 && (
    <RailSection title={t.docInfo}>
      <dl className="space-y-2 text-[12.5px]">
        {facts.map((f) => (
          <div key={f.k}>
            <dt className="text-ink-4">{f.label}</dt>
            <dd className="mt-0.5 text-ink-2">{f.value}</dd>
          </div>
        ))}
      </dl>
    </RailSection>
  );
  const outline = rendered.outline.length > 2 && (
    <RailSection title={t.outline}>
      <nav aria-label={t.outline}>
        <ol className="-ml-px space-y-0.5 border-l border-line">
          {rendered.outline.map((o) => (
            <li key={o.id}>
              <a href={`#${o.id}`} className="-ml-px block border-l border-transparent py-1 pl-3 text-[12.5px] leading-snug text-ink-3 transition-colors hover:border-accent hover:text-ink">
                {o.text}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </RailSection>
  );
  return (
    <ArticleLayout
      left={
        <>
          {aside}
          {info}
        </>
      }
      right={
        <>
          <div className="space-y-8 2xl:hidden">{info}</div>
          {outline}
        </>
      }
    >
      <article className="pb-14 pt-5 lg:pt-2">
        {eyebrow && <div className="mb-2.5 text-[12px] font-semibold text-accent">{eyebrow}</div>}
        <h1 className="text-[26px] font-bold leading-[1.35] text-ink lg:text-[32px] xl:text-[36px] xl:leading-[1.3]">{doc.title}</h1>
        {doc.intro && <p className="mt-4 text-[15px] leading-[1.8] text-ink-3 xl:text-[16px]">{doc.intro}</p>}
        {facts.length > 0 && (
          <dl className="mt-5 grid grid-cols-1 border-y border-line text-[12.5px] sm:grid-cols-2 lg:hidden">
            {facts.map((f) => (
              <div key={f.k} className="flex gap-4 border-b border-line-soft py-2.5 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0">
                <dt className="w-16 shrink-0 text-ink-4">{f.label}</dt>
                <dd className="min-w-0 text-ink-2">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="prose prose-compact mt-6 lg:mt-8" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        {footer && <div className="mt-12 border-t border-line pt-5 text-[12.5px] text-ink-3">{footer}</div>}
      </article>
    </ArticleLayout>
  );
}

export function LegalFooterLinks({ links, note }: { links: Array<{ to: string; label: string; id?: string }>; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {links.map((l) => (
        <Link key={l.to} id={l.id} to={l.to} className="text-accent hover:underline">{l.label}</Link>
      ))}
      {note && <span className="text-ink-4">{note}</span>}
    </div>
  );
}
