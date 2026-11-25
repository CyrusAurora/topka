// Source regions (0004-globalization-v1, item E): the pure helpers live in @topka/contracts/regions
// so the backend, the API and the wizard web app share one filter rule. This module re-exports them
// for backend call sites (`@topka/backend/sources/regions`).
export { SOURCE_REGION_TOKENS, isValidRegionToken, normalizeRegions, parseRegionFilter, sourceMatchesRegionFilter } from "@topka/contracts/regions";
export type { SourceRegionToken } from "@topka/contracts/regions";
