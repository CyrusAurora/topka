import { beijingDate, beijingTime, beijingWeekday } from "@topka/contracts/time";
import { intlLocale, messages, type UiLocale } from "./i18n.ts";

export { beijingDate, beijingTime, beijingWeekday };

export function dayLabel(date: string, today: string, locale: UiLocale = "zh-CN"): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = messages(locale).common;
  const base = t.monthDay(m, d);
  if (date === today) return `${t.todayLabel}${base}`;
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  if (diff === 1) return `${t.yesterdayLabel}${base}`;
  if (y !== Number(today.slice(0, 4))) return t.monthDayYear(y, m, d);
  return base;
}

export function relativeTime(iso: string, now = Date.now(), locale: UiLocale = "zh-CN", timeZone: string = "Asia/Shanghai"): string {
  const t = messages(locale).common;
  const time = Date.parse(iso);
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 60) return t.justNow;
  const m = Math.round(s / 60);
  if (m < 60) return t.minutesAgo(m);
  const h = Math.round(m / 60);
  if (h < 24) return t.hoursAgo(h);
  const d = Math.round(h / 24);
  if (d < 30) return t.daysAgo(d);
  if (locale === "en") return new Intl.DateTimeFormat(intlLocale(locale), { month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(iso));
  return beijingDate(iso);
}

export function fullDateTime(iso: string, locale: UiLocale = "zh-CN", timeZone: string = "Asia/Shanghai"): string {
  if (locale === "en") {
    const date = new Intl.DateTimeFormat(intlLocale(locale), { month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(iso));
    const clock = new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(iso));
    return `${date}, ${clock}`;
  }
  return `${beijingDate(iso)} ${beijingTime(iso)}`;
}

/** "9月24日 10:51" (Beijing), for lists that span days. */
export function monthDayTime(iso: string, locale: UiLocale = "zh-CN", timeZone: string = "Asia/Shanghai"): string {
  if (locale === "en") {
    const parts = new Intl.DateTimeFormat(intlLocale(locale), { month: "numeric", day: "numeric", timeZone }).formatToParts(new Date(iso));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    const clock = new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(iso));
    return `${messages(locale).common.monthDay(get("month"), get("day"))} ${clock}`;
  }
  const [, m, d] = beijingDate(iso).split("-").map(Number) as [number, number, number];
  return `${messages(locale).common.monthDay(m, d)} ${beijingTime(iso)}`;
}

/** "X：Ethan Mollick (@emollick)" → "Ethan Mollick"; other sources keep their name. */
export function shortSourceName(name: string): string {
  const m = /^X[:：]\s*(.+?)\s*\(@[^)]+\)\s*$/.exec(name);
  if (m) return m[1]!.replace(/（.*?）/g, "").trim();
  return name.replace(/（RSS）|（网页）|（API）/g, "").trim();
}

export function sourceInitial(name: string): string {
  const s = shortSourceName(name).replace(/^[^\p{L}\p{N}]+/u, "");
  return (s[0] ?? "A").toUpperCase();
}
