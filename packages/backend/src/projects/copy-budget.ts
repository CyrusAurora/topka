// Copy budget for the 今日 cards: every half-sentence is measured in width units (CJK and
// full-width punctuation = 1, Latin letters, digits and half-width signs = 0.55, space = 0.3)
// so copy can be generated to fit the narrowest target screen and reported field by field
// when it breaks the budget — over-budget copy is rewritten or handed to a fallback, never cut.
export const BUDGET = { titleA: 12, heroTitle: 24, itemTitle: 30, heroCore: 16, itemCore: 19, tagChars: 18, source: 14, summaryMin: 60, summaryMax: 120 } as const;

/** Measured width of a string in budget units. */
export function widthUnits(s: string): number {
  let w = 0;
  for (const ch of s) w += ch === " " ? 0.3 : ch < "\u2000" ? 0.55 : 1;
  return Math.round(w * 100) / 100;
}

/** Whether a space goes between the title halves: title_a shown with 「，：、（」 keeps its tail glued to title_b. */
export function titleGap(titleA: string): boolean {
  return !/[（，：、）,:(]$/.test(titleA);
}

/** Title width as the browser lays it out: a + gap + b, the gap only when both halves and it fit. */
export function titleUnits(a: string, b: string): number {
  return Math.round((widthUnits(a) + (b ? (titleGap(a) ? 0.3 : 0) + widthUnits(b) : 0)) * 100) / 100;
}

export interface CopyFields {
  title_a: string;
  title_b: string;
  core_a: string;
  core_b: string;
  summary: string;
  tag: string;
  source: string;
}
export type CopyField = keyof CopyFields;
export interface BudgetProblem {
  field: CopyField;
  units: number;
  limit: number;
  kind: "over" | "under" | "empty";
}

/** Every broken budget of one item's copy, in field order; the caller trims the strings. */
export function budgetProblems(c: CopyFields, hero: boolean): BudgetProblem[] {
  const problems: BudgetProblem[] = [];
  const titleLimit = hero ? BUDGET.heroTitle : BUDGET.itemTitle;
  const coreLimit = hero ? BUDGET.heroCore : BUDGET.itemCore;
  if (!c.title_a) problems.push({ field: "title_a", units: 0, limit: BUDGET.titleA, kind: "empty" });
  else if (widthUnits(c.title_a) > BUDGET.titleA) problems.push({ field: "title_a", units: widthUnits(c.title_a), limit: BUDGET.titleA, kind: "over" });
  else {
    const units = titleUnits(c.title_a, c.title_b);
    if (units > titleLimit) problems.push({ field: "title_b", units, limit: titleLimit, kind: "over" });
  }
  for (const field of ["core_a", "core_b"] as const) {
    if (!c[field]) problems.push({ field, units: 0, limit: coreLimit, kind: "empty" });
    else if (widthUnits(c[field]) > coreLimit) problems.push({ field, units: widthUnits(c[field]), limit: coreLimit, kind: "over" });
  }
  const summaryUnits = widthUnits(c.summary);
  if (!c.summary) problems.push({ field: "summary", units: 0, limit: BUDGET.summaryMin, kind: "empty" });
  else if (summaryUnits < BUDGET.summaryMin) problems.push({ field: "summary", units: summaryUnits, limit: BUDGET.summaryMin, kind: "under" });
  else if (summaryUnits > BUDGET.summaryMax) problems.push({ field: "summary", units: summaryUnits, limit: BUDGET.summaryMax, kind: "over" });
  const tagUnits = [...c.tag].length;
  if (!c.tag) problems.push({ field: "tag", units: 0, limit: BUDGET.tagChars, kind: "empty" });
  else if (tagUnits > BUDGET.tagChars) problems.push({ field: "tag", units: tagUnits, limit: BUDGET.tagChars, kind: "over" });
  if (!c.source) problems.push({ field: "source", units: 0, limit: BUDGET.source, kind: "empty" });
  else if (widthUnits(c.source) > BUDGET.source) problems.push({ field: "source", units: widthUnits(c.source), limit: BUDGET.source, kind: "over" });
  return problems;
}
