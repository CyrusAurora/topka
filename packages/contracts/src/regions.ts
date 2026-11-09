// Source regions (0004-globalization-v1, item E): geography on sources, separate from `in_scope`
// (industry-topic scope, 0054). Tokens are ISO 3166-1 alpha-2 lowercase plus `global`; the short
// list below is the recommended set for the wizard UI and docs — any non-empty lowercase token is
// stored, so adding a region later needs no schema change.
export const SOURCE_REGION_TOKENS = ["global", "cn", "us", "eu", "jp"] as const;
export type SourceRegionToken = (typeof SOURCE_REGION_TOKENS)[number];

const REGION_TOKEN_RE = /^[a-z][a-z0-9-]{0,15}$/;

export function isValidRegionToken(s: string): boolean {
  if (!s) return false;
  if (s === "global") return true;
  if ((SOURCE_REGION_TOKENS as readonly string[]).includes(s)) return true;
  return REGION_TOKEN_RE.test(s) && s === s.toLowerCase();
}

/** Unique, lowercased, valid tokens only; an empty result falls back to ["global"]. */
export function normalizeRegions(input: unknown): string[] {
  if (!Array.isArray(input)) return ["global"];
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const token = entry.trim().toLowerCase();
    if (token && isValidRegionToken(token) && !out.includes(token)) out.push(token);
  }
  return out.length ? out : ["global"];
}

export function parseRegionFilter(q: string | null | undefined): string[] {
  if (!q) return [];
  const parts = q.split(/[,\s]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  return [...new Set(parts.filter((p) => isValidRegionToken(p)))];
}

/** No filter shows everything; under a filter `global` sources are always visible (ADR E). */
export function sourceMatchesRegionFilter(sourceRegions: readonly string[], filter: readonly string[]): boolean {
  const f = (filter ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (f.length === 0) return true;
  const src = (sourceRegions ?? []).map((x) => String(x).trim().toLowerCase());
  if (src.includes("global")) return true;
  return src.some((r) => f.includes(r));
}
