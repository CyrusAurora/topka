// Evidence discipline for the daily issue (docs/quality.md, 弃答): an item whose evidence is too thin to
// support a card is left out, and the issue stays shorter rather than filled (宁少不凑). The rules only
// look at what the item itself carries; they never weigh how interesting it is.
//
//   no-source        no http(s) link to the original: a reader could not check anything.
//   title-only       nothing but the title (no body, no feed summary, no post text).
//   thin             some text, but under MIN_TEXT_UNITS: too little to summarise without guessing.
//   unsourced-claim  the lead rests on anonymous sourcing (知情人士, reportedly…) with no named outlet,
//                    not from the company itself nor confirmed by it, and nobody else independently
//                    reports it.
//   source-conflict  another, independent report in the same story denies the item's claim: a reported
//                    (anonymous or relayed) claim, or the very thing its title says.
import { relayedOutlet } from "../events/independence.ts";

export type AbstainReason = "no-source" | "title-only" | "thin" | "unsourced-claim" | "source-conflict";

export interface EvidenceInput {
  url: string | null;
  title: string;
  /** Extracted body, feed summary and (X) post text; any may be empty. */
  body: string;
  excerpt: string;
  postText: string;
  /** The source speaks for the subject itself (a company blog, an official account). */
  firstParty: boolean;
  /** Independent upstreams reporting the story (1 when the item is alone). */
  upstreams: number;
  /** Titles of the story's other reports that come from a different upstream. */
  otherReports: string[];
}

export type EvidenceVerdict = { sufficient: true } | { sufficient: false; reason: AbstainReason; detail: string };

/** Fewer text units than this (CJK characters + Latin words) is too thin to support a card. */
export const MIN_TEXT_UNITS = 40;

/** The claim is what the title and the first sentence say; later mentions are background. */
export function leadOf(title: string, text: string): string {
  const m = text.slice(0, 240).match(/^.{15,}?(?:[。！？!?]|\.\s)/s);
  return `${title}\n${m ? m[0] : text.slice(0, 200)}`;
}

const RUMOR = /(^(曝|网曝)(?!光)|^消息称|知情人士|消息人士|(?<!数)据传|传闻|网传|爆料|小道消息|未经证实|有消息称|业内人士透露|reportedly|(?<![A-Za-z])rumou?r(ed|s)?|people familiar with|sources (say|said|told)|according to (people|sources|a person)|unconfirmed)/i;
/** The subject itself has spoken: anonymous sourcing in the body is then background. */
const CONFIRMED = /(确认|证实|官宣|回应称|confirm(s|ed)?|announce[sd]?|said in a statement)/i;
const DENIAL = /(否认|辟谣|不实|假消息|谣言|并非事实|不属实|回应.{0,6}(传闻|报道)|denie[sd]|deny|refute[sd]?|debunk|false (report|claim)|not true|retract(s|ed|ion)?)/i;

/** CJK characters plus Latin/number words: a length that means the same in Chinese and English. */
export function textUnits(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const words = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9][A-Za-z0-9'’.-]*/g)?.length ?? 0;
  return cjk + words;
}

/** Share of a title's grams found in another title at which both speak about the same claim. */
export const SAME_CLAIM_OVERLAP = 0.6;

const grams = (title: string) => {
  const t = title.toLowerCase();
  const out = new Set(t.match(/[a-z0-9][a-z0-9.-]*/g) ?? []);
  const cjk = t.replace(/[^\u3400-\u9fff]+/g, " ");
  for (let i = 0; i + 1 < cjk.length; i++) if (cjk[i] !== " " && cjk[i + 1] !== " ") out.add(cjk.slice(i, i + 2));
  return out;
};

/** How much of `title` (word and CJK-bigram grams) reappears in `other`, 0..1. */
export function titleOverlap(title: string, other: string): number {
  const a = grams(title);
  if (!a.size) return 0;
  const b = grams(other);
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

export function assessEvidence(e: EvidenceInput): EvidenceVerdict {
  if (!e.url || !/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(e.url)) return { sufficient: false, reason: "no-source", detail: "no link to the original" };
  // The longest of what the item carries: some feeds put the whole text in the summary.
  const text = [e.body, e.excerpt, e.postText].reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), "");
  const units = textUnits(text);
  if (units === 0) return { sufficient: false, reason: "title-only", detail: "no body, summary or post text" };
  if (units < MIN_TEXT_UNITS) return { sufficient: false, reason: "thin", detail: `${units} text units < ${MIN_TEXT_UNITS}` };
  const lead = leadOf(e.title, text);
  const rumor = lead.match(RUMOR);
  const confirmed = e.firstParty || CONFIRMED.test(e.title) || DENIAL.test(e.title);
  if (rumor && !confirmed && e.upstreams < 2 && !relayedOutlet(text)) {
    return { sufficient: false, reason: "unsourced-claim", detail: `anonymous sourcing ("${rumor[0].trim()}"), one upstream` };
  }
  // A denial counts against a reported claim (anonymous or relayed), or against any item whose own
  // title it repeats; a denial of some side detail does not undo what the company itself confirmed.
  if (!DENIAL.test(e.title)) {
    const reported = (rumor || relayedOutlet(text)) && !confirmed;
    const denial = e.otherReports.find((t) => DENIAL.test(t) && (reported || titleOverlap(e.title, t) >= SAME_CLAIM_OVERLAP));
    if (denial) return { sufficient: false, reason: "source-conflict", detail: `contradicted: ${denial.slice(0, 80)}` };
  }
  return { sufficient: true };
}
