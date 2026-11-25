// Category vocabulary shared by the website, the API and the worker. The categories themselves belong
// to the industry pack (industry/taxonomy.ts); their keys are stored with every article.
import { CATEGORIES } from "@topka/industry/taxonomy";

export type CategoryKey = (typeof CATEGORIES)[number]["key"];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as unknown as readonly [CategoryKey, ...CategoryKey[]];

/** Category labels, as the admin shows them. */
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<CategoryKey, string>;

/** Article ids. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
