import { useEffect, useState, type ReactNode } from "react";
import { IconMonitor, IconMoon, IconSun } from "../icons";
import { resolvedTheme, setThemePreference, useThemePreference, type ThemePreference } from "../../lib/local-state";
import { chromeStrings, normalizeUiLocale, type UiLocale } from "../../lib/i18n";

type Choice = "dark" | "system" | "light";

/** Three-way appearance switch (dark / follow the system / light) with a sliding thumb. */
export function ThemeSwitch({ className = "", locale = "zh-CN" }: { className?: string; locale?: UiLocale }) {
  const strings = chromeStrings(normalizeUiLocale(locale));
  const OPTIONS: Array<{ key: Choice; label: string; icon: ReactNode }> = [
    { key: "dark", label: strings.dark, icon: <IconMoon size={14} /> },
    { key: "system", label: strings.system, icon: <IconMonitor size={14} /> },
    { key: "light", label: strings.light, icon: <IconSun size={14} /> },
  ];
  const pref = useThemePreference();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current: Choice = !mounted ? "system" : (pref ?? "system");
  const index = OPTIONS.findIndex((o) => o.key === current);

  const choose = (key: Choice) => {
    const nextPref: ThemePreference = key === "system" ? null : key;
    const apply = () => {
      setThemePreference(nextPref);
      document.documentElement.setAttribute("data-theme", resolvedTheme(nextPref));
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(apply);
    else apply();
  };

  return (
    <div role="radiogroup" aria-label={strings.appearance} className={`relative grid h-[34px] grid-cols-3 rounded-full border border-line bg-bg-sunk p-[3px] ${className}`}>
      <span
        aria-hidden="true"
        className="absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/3)] rounded-full border border-line bg-surface shadow-[var(--shadow-card)] transition-transform duration-200 ease-[var(--ease-out-quart)]"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={current === o.key}
          title={o.label}
          onClick={() => choose(o.key)}
          className={`relative z-10 flex items-center justify-center rounded-full transition-colors duration-150 ${current === o.key ? "text-ink" : "text-ink-4 hover:text-ink-2"}`}
        >
          {o.icon}
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
