import { beijingDate, beijingTime, beijingWeekday } from "@topka/contracts/time";
import { intlLocale, messages, type UiLocale } from "./i18n.ts";

export { beijingDate, beijingTime, beijingWeekday };

/** "X：Ethan Mollick (@emollick)" → "Ethan Mollick"; other sources keep their name. */
export function shortSourceName(name: string): string {
  const m = /^X[:：]\s*(.+?)\s*\(@[^)]+\)\s*$/.exec(name);
  if (m) return m[1]!.replace(/（.*?）/g, "").trim();
  return name.replace(/（RSS）|（网页）|（API）/g, "").trim();
}
