// Shared admin vocabulary.
import { messages, type UiLocale } from "../../lib/i18n.ts";

// Look labels up in the page's language: `labels(locale)` or `useT().adminShell.labels`.

export interface AdminLabels {
  kind: Record<string, string>;
  mode: Record<string, string>;
  health: Record<string, string>;
  visibility: Record<string, string>;
  feedbackStatus: Record<string, string>;
  tier: Record<string, string>;
}

export function labels(locale: UiLocale = "zh-CN"): AdminLabels {
  return messages(locale).adminShell.labels;
}
