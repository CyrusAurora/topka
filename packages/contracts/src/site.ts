// First-party site API (/api/site/*): the about page's figures. Not a public API.

export interface SiteStats {
  /** Sources collected from now. */
  sources: number;
  /** Enabled sources by kind: x_search, rss, web_list, mp_account, json_list. */
  sourceKinds: Record<string, number>;
  /** Of them, sources that only count as discussion evidence (their items never reach an issue). */
  heatOnlySources: number;
  /** Everything collected and not withdrawn, discussion-only sources included. */
  items: number;
  /** Items readers got in their issues. */
  selected: number;
  /** Days with at least one finished issue. */
  dailies: number;
  /** The last 24 hours: items found, and items that reached an issue. */
  day: { collected: number; selected: number };
  /** Enabled sources in a daily shuffle, for the about page's river: one line per source. */
  sampleSources: Array<{ name: string; kind: string; heatOnly: boolean }>;
  /** The newest selected items of the pool, newest first. */
  latest: Array<{ id: string; title: string; source: string }>;
}
