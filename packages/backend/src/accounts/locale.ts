// Reader locales for globalization v1 (ADR 0004 §D): v1 supports only zh-CN | en.
// Output language token for card-copy prompts is the bare language tag: "zh" | "en"
// (mapped from users.locale "zh-CN" | "en"; prompts key off {{outputLanguage}} as zh/en).
export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type OutputLanguage = "zh" | "en";

export function isValidLocale(v: unknown): v is SupportedLocale {
  return typeof v === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

export function normalizeLocale(v: unknown): SupportedLocale {
  return isValidLocale(v) ? v : "zh-CN";
}

/** Map a users.locale value to the prompt outputLanguage token. */
export function outputLanguageFor(locale: unknown): OutputLanguage {
  return normalizeLocale(locale) === "en" ? "en" : "zh";
}
