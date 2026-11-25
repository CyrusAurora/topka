// Publication rules. Each rule is defined once here and used by every exit.

export interface SourceFacts {
  id: string;
  name: string;
  kind: string;
  tier: string;
  participation_mode: string;
  first_party: boolean;
  site_fulltext: boolean;
}

export function channelOf(sourceKind: string, hasXPost: boolean): "x" | "news" {
  return sourceKind === "x_search" || hasXPost ? "x" : "news";
}

/** Public pool (/all): editorial sources, AI relevant, with a Chinese title and summary. */
export function isPoolEligible(input: {
  participationMode: string;
  relevance: string | null;
  title: string | null;
  summary: string | null;
}): boolean {
  return input.participationMode === "editorial" && input.relevance === "pass" && !!input.title && !!input.summary;
}

/** Selected: pool eligible, judged selected, and the source tier may enter the selection. */
export function isSelectable(eligible: boolean, judgedSelected: boolean | null, tier: string): boolean {
  return eligible && judgedSelected === true && tier !== "EXCLUDE_MP";
}

/**
 * Site full text: the source licence allows showing it and we have confirmed body text.
 * WeChat and paywalled content never get it just because it was fetchable (source flag false).
 */
export function bodyModeOf(source: SourceFacts, bodyStatus: string, hasBody: boolean): "full" | "summary" {
  return source.site_fulltext && bodyStatus === "ok" && hasBody ? "full" : "summary";
}
