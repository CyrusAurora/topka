import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLoaderData } from "react-router";
import type { SiteStats } from "@topka/contracts/site";
import { apiGet } from "../lib/api.server";
import { shortSourceName } from "../lib/format";
import { aboutCopy, SITE, siteCopy, type AboutCopy } from "@topka/industry/site";
import type { Route } from "./+types/about";
import { localeOf, messages, useLocale, useT, type UiLocale } from "../lib/i18n";
import { organizationLd, pageMeta } from "../lib/seo";
import { Kicker } from "../components/ui/Kicker";
import { buttonClass } from "../components/ui/Controls";
import { IconArrowRight } from "../components/icons";
import { SignalRiver, type RiverSource } from "../features/about/SignalRiver";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

interface ContactSettings {
  wechatQr: string | null;
  feishuQr: string | null;
  /** The maker's X avatar through the image proxy, when the site follows that account. */
  makerAvatar?: string | null;
}

export async function loader({ request }: { request: Request }) {
  const [contact, stats] = await Promise.all([
    apiGet<ContactSettings>("/api/site/contact", { signal: request.signal }).catch((): ContactSettings => ({ wechatQr: null, feishuQr: null, makerAvatar: null })),
    apiGet<SiteStats>("/api/site/stats", { signal: request.signal }).catch(() => null),
  ]);
  return { contact, stats };
}

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale).about;
  return pageMeta({ title: t.metaTitle, description: t.metaDescription(SITE.name, siteCopy(locale).description), path: "/about", image: "/og/pages/about.png", jsonLd: organizationLd(), locale });
};

const NO_SOURCES: RiverSource[] = [];

/** 3.6 万 (zh) or 36k (en) from ten thousand up, digits with separators below. */
function figure(n: number, locale: UiLocale): { value: string; unit: string } {
  if (n < 10_000) return { value: n.toLocaleString("en-US"), unit: "" };
  if (locale === "en") return { value: `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, "")}k`, unit: "" };
  return { value: (n / 10_000).toFixed(1).replace(/\.0$/, ""), unit: messages(locale).about.tenThousand };
}

function Figure({ n, unit }: { n: number; unit: string }) {
  const f = figure(n, useLocale());
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="num text-[30px] font-black leading-none tracking-[-0.03em] text-ink xl:text-[36px]">{f.value}</span>
      <span className="text-[13px] text-ink-3">
        {f.unit}
        {unit}
      </span>
    </div>
  );
}

const KIND_ORDER = ["x_search", "rss", "web_list", "mp_account", "json_list"] as const;
const kindLabel = (k: (typeof KIND_ORDER)[number], locale: UiLocale) =>
  k === "x_search" ? "X" : k === "rss" ? "RSS" : messages(locale).about.kinds[k];

/**
 * The stage columns' rules: one column on phones, two by two from sm, and from lg four in a row whose
 * edges fall on the river's stage boundaries.
 */
const STAGE_CELL = [
  "sm:pr-6 lg:pr-6",
  "border-t sm:border-l sm:border-t-0 sm:pl-6 lg:px-6",
  "border-t sm:pr-6 lg:border-l lg:border-t-0 lg:px-6",
  "border-t sm:border-l sm:pl-6 lg:border-t-0 lg:px-6",
];

interface Stage {
  no: string;
  title: string;
  figure: ReactNode;
  text: string;
  note: ReactNode;
}

function stagesOf(stats: SiteStats | null, locale: UiLocale, about: AboutCopy): Stage[] {
  const t = messages(locale).about;
  const kinds = stats ? KIND_ORDER.filter((k) => stats.sourceKinds[k]).map((k) => `${kindLabel(k, locale)} ${stats.sourceKinds[k]}`).join(" · ") : null;
  return [
    {
      no: "01",
      title: t.stages.collect,
      figure: stats && <Figure n={stats.sources} unit={t.units.sources} />,
      text: about.steps.collect,
      note: kinds,
    },
    {
      no: "02",
      title: t.stages.store,
      figure: stats && <Figure n={stats.items} unit={t.units.items} />,
      text: about.steps.store,
      note: stats && t.collectedDay(stats.day.collected.toLocaleString("en-US")),
    },
    {
      no: "03",
      title: t.stages.select,
      figure: stats && <Figure n={stats.selected} unit={t.units.selected} />,
      text: about.steps.select,
      note: stats && t.selectedDay(stats.day.selected),
    },
    {
      no: "04",
      title: t.stages.publish,
      figure: stats && <Figure n={stats.dailies} unit={t.units.dailies} />,
      text: about.steps.publish,
      note: t.subscribe,
    },
  ];
}

/** The maker's round avatar before the greeting; it steps aside if the image fails. */
function MakerFace({ src, name }: { src: string; name: string }) {
  const t = useT().about;
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={src} alt={t.avatarAlt(name)} width={48} height={48} onError={() => setFailed(true)} className="size-11 shrink-0 rounded-full bg-bg-sunk object-cover ring-1 ring-line xl:size-12" />;
}

function QrCard({ src, kind, title, note }: { src: string; kind: string; title: string; note: string }) {
  const t = useT().about;
  return (
    <figure className="card flex items-center gap-5 p-5">
      <img src={src} alt={t.qrAlt(kind)} width={112} height={112} loading="lazy" className="size-[104px] shrink-0 rounded-tile border border-line bg-white object-contain p-1.5 sm:size-[112px]" />
      <figcaption className="min-w-0">
        <div className="text-[12px] text-ink-4">{kind}</div>
        <div className="mt-1 text-[16px] font-semibold leading-snug text-ink">{title}</div>
        <p className="mt-2 text-[13px] leading-[1.7] text-ink-3">{note}</p>
      </figcaption>
    </figure>
  );
}

/** The optional maker block (ABOUT.maker): a greeting on the left, the contact codes that are set on the right. */
function Maker({ maker, contact }: { maker: NonNullable<AboutCopy["maker"]>; contact: ContactSettings }) {
  const t = useT().about;
  const codes = [
    contact.wechatQr && maker.wechat ? <QrCard key="wechat" src={contact.wechatQr} kind={t.wechat} title={maker.wechat.title} note={maker.wechat.note} /> : null,
    contact.feishuQr && maker.feishu ? <QrCard key="feishu" src={contact.feishuQr} kind={t.feishu} title={maker.feishu.title} note={maker.feishu.note} /> : null,
  ].filter(Boolean);
  return (
    <section aria-labelledby="maker" className="mt-20 grid gap-10 xl:mt-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
      <div>
        <Kicker>{t.makerKicker}</Kicker>
        <h2 id="maker" className="mt-4 flex items-center gap-3.5 text-[26px] font-black leading-[1.3] tracking-[-0.02em] text-ink xl:gap-4 xl:text-[34px]">
          {contact.makerAvatar && <MakerFace src={contact.makerAvatar} name={maker.name} />}
          <span>
            {t.hello} <span className="whitespace-nowrap text-accent">{maker.name}</span>
          </span>
        </h2>
        <div className="mt-5 space-y-4 text-[15.5px] leading-[1.9] text-ink-2 xl:text-[16.5px]">
          {maker.greeting.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="text-ink-3">
            {t.feedbackBefore}
            <Link to="/feedback" className="text-accent hover:underline">
              {t.feedbackLink}
            </Link>
            {t.feedbackAfter}
          </p>
        </div>
      </div>
      {codes.length > 0 && (
        <div className="grid content-start gap-3">
          <h3 className="text-[15px] font-semibold text-ink">{t.join}</h3>
          {codes}
        </div>
      )}
    </section>
  );
}

/** The latest 精选 under the river's paper; it moves on each time an item reaches the paper. */
function Latest({ item, className = "" }: { item: SiteStats["latest"][number] | undefined; className?: string }) {
  const t = useT().about;
  if (!item) return null;
  return (
    <Link to={`/items/${item.id}`} prefetch="intent" className={`group block ${className}`}>
      <span className="text-[11px] font-semibold tracking-[0.2em] text-accent">{t.latest}</span>
      <span key={item.id} className="animate-fade-up mt-1.5 block">
        <span className="line-clamp-2 text-[13.5px] font-semibold leading-[1.55] text-ink transition-colors group-hover:text-accent">{item.title}</span>
        <span className="mt-1 block truncate text-[12px] text-ink-4">{shortSourceName(item.source)}</span>
      </span>
    </Link>
  );
}

export default function AboutPage() {
  const { contact, stats } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const t = messages(locale).about;
  const about = aboutCopy(locale);
  const [focus, setFocus] = useState<number | null>(null);
  const [at, setAt] = useState(0);
  const shown = useRef(0);
  const sources = useMemo(() => stats?.sampleSources ?? NO_SOURCES, [stats]);
  const stages = useMemo(() => stagesOf(stats, locale, about), [stats, locale, about]);
  const latest = stats?.latest ?? [];
  // A pulse reaches the paper every second or so; the headline under it changes at most every 2.8s.
  const onArrive = useCallback(() => {
    const now = Date.now();
    if (now - shown.current < 2800 || latest.length < 2) return;
    shown.current = now;
    setAt((i) => (i + 1) % latest.length);
  }, [latest.length]);

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14 pt-6 lg:pt-3">
      <header className="grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <Kicker>{about.kicker}</Kicker>
          <h1 className="mt-5 text-[34px] font-black leading-[1.18] tracking-[-0.03em] text-ink [text-wrap:balance] sm:text-[46px] xl:text-[56px] 2xl:text-[64px]">
            {about.headline[0]}
            <br />
            <span className="text-accent">{about.headline[1]}</span>
          </h1>
          <p className="mt-5 max-w-[36em] text-[15.5px] leading-[1.85] text-ink-3 xl:text-[17px]">
            {about.lead.split("{sources}").map((part, i) => (
              <span key={i}>
                {i > 0 && (stats ? <span className="num font-semibold text-ink">{stats.sources}</span> : t.manySources)}
                {part}
              </span>
            ))}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:pb-2">
          <Link to="/" prefetch="intent" className={buttonClass("primary", "lg")}>
            {t.seeToday} <IconArrowRight size={15} />
          </Link>
          <Link to="/archive" prefetch="intent" className={buttonClass("secondary", "lg")}>
            {t.browseArchive}
          </Link>
        </div>
      </header>

      <section aria-labelledby="how" className="mt-10 xl:mt-14">
        <h2 id="how" className="sr-only">
          {t.howItWorks(SITE.name)}
        </h2>
        <SignalRiver sources={sources} focus={focus} onArrive={onArrive} className="h-[230px] sm:h-[300px] lg:h-[360px] 2xl:h-[420px]">
          <Latest item={latest[at]} className="absolute left-[75%] top-[calc(42%+42px)] hidden w-[25%] px-6 lg:block" />
        </SignalRiver>
        <p className="sr-only">{t.riverAlt}</p>
        <Latest item={latest[at]} className="mt-2 border-t border-line pt-4 lg:hidden" />
        <ol className="mt-4 grid grid-cols-1 border-t border-line-strong sm:grid-cols-2 lg:mt-0 lg:grid-cols-4">
          {stages.map((s, i) => (
            <li
              key={s.no}
              tabIndex={0}
              onPointerEnter={() => setFocus(i)}
              onPointerLeave={() => setFocus(null)}
              onFocus={() => setFocus(i)}
              onBlur={() => setFocus(null)}
              className={`border-line py-6 outline-none transition-colors ${STAGE_CELL[i]} ${focus === i ? "bg-accent-softer" : ""}`}
            >
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[12px] font-bold tracking-[0.12em] text-accent">{s.no}</span>
                <h3 className="text-[17px] font-bold text-ink">{s.title}</h3>
              </div>
              {s.figure && <div className="mt-4">{s.figure}</div>}
              <p className="mt-3 text-[14px] leading-[1.8] text-ink-3">{s.text}</p>
              {s.note && <p className="mt-3 text-[12px] text-ink-4">{s.note}</p>}
            </li>
          ))}
        </ol>
      </section>

      {about.maker && <Maker maker={about.maker} contact={contact} />}

      <p className="mt-16 well rounded-card px-5 py-4 text-[13px] leading-[1.85] text-ink-3">
        {about.copyright}
        {locale === "en" ? " " : ""}
        <Link to="/feedback" className="text-accent hover:underline">
          {t.feedbackLink}
        </Link>
        {t.contactAfter}
      </p>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[12.5px] text-ink-4">
        <span>{siteCopy(locale).footerNote}</span>
        {SITE.legalPages && (
          <nav className="flex gap-5" aria-label={t.legalNav}>
            <Link to="/terms" className="transition-colors hover:text-accent">
              {t.terms}
            </Link>
            <Link to="/privacy" className="transition-colors hover:text-accent">
              {t.privacy}
            </Link>
          </nav>
        )}
      </footer>
    </div>
  );
}
