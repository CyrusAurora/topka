// Reader preferences kept only in this browser: the theme and an unsent feedback draft. Storage
// failures degrade silently. Keep the keys and formats once readers have data under them.
import { useSyncExternalStore } from "react";

export const KEYS = {
  theme: "topka-theme",
  feedbackDraft: "topka-feedback-draft-v1",
} as const;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// Change notification: this tab through the listeners, other tabs through the storage event.
const listeners = new Set<() => void>();
function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === KEYS.theme) for (const l of listeners) l();
}
function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export type ThemePreference = "light" | "dark" | null;

function getThemePreference(): ThemePreference {
  const v = readRaw(KEYS.theme);
  if (v === "light" || v === "dark") return v;
  // Tolerate a JSON-quoted value written by other code paths.
  if (v === '"light"' || v === '"dark"') return JSON.parse(v);
  return null;
}

export function setThemePreference(pref: ThemePreference) {
  writeRaw(KEYS.theme, pref);
  for (const l of listeners) l();
}

export function resolvedTheme(pref: ThemePreference = getThemePreference()): "light" | "dark" {
  if (pref) return pref;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Inline script run before paint so the first frame already has the reader's theme. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEYS.theme}');if(t==='"light"'||t==='"dark"')t=JSON.parse(t);if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, getThemePreference, () => null);
}
