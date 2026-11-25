// Admin display helpers: Beijing wall-clock times, relative ages, compact numbers.
import { DEFAULT_TIME_ZONE, intlLocale, messages, type UiLocale } from "../../lib/i18n.ts";
const BJ = 8 * 3600_000;

export function bj(iso: string | Date | null | undefined, withYear = false, locale: UiLocale = "zh-CN", timeZone: string = DEFAULT_TIME_ZONE): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return "—";
  if (locale === "zh-CN" && timeZone === DEFAULT_TIME_ZONE) {
    const s = new Date(t + BJ).toISOString();
    return `${withYear ? `${s.slice(0, 4)}-` : ""}${s.slice(5, 10)} ${s.slice(11, 16)}`;
  }
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    ...(withYear ? { year: "numeric" as const } : {}),
    month: locale === "en" ? ("short" as const) : ("2-digit" as const),
    day: locale === "en" ? ("numeric" as const) : ("2-digit" as const),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

export function ago(iso: string | Date | null | undefined, now = Date.now(), locale: UiLocale = "zh-CN"): string {
  if (!iso) return messages(locale).adminShell.format.never;
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const future = ms < 0;
  const a = Math.abs(ms);
  const f = messages(locale).adminShell.format;
  const text =
    a < 60_000 ? f.seconds(Math.max(1, Math.round(a / 1000)))
    : a < 3600_000 ? f.minutes(Math.round(a / 60_000))
    : a < 86400_000 ? f.hours(Math.round(a / 3600_000))
    : f.days(Math.round(a / 86400_000));
  return future ? f.fromNow(text) : f.ago(text);
}

export function num(n: number | string | null | undefined, digits = 0, locale: UiLocale = "zh-CN"): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString(intlLocale(locale), { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function money(n: number | string | null | undefined, currency = "CNY", locale: UiLocale = "zh-CN"): string {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  const sign = currency === "USD" ? "$" : "¥";
  return `${sign}${v.toLocaleString(intlLocale(locale), { maximumFractionDigits: v < 10 ? 3 : 2, minimumFractionDigits: 2 })}`;
}

export function duration(from: string | null, to: string | null): string {
  if (!from || !to) return "—";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function pct(v: number | null | undefined, digits = 1): string {
  return v === undefined || v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}
