// The states every magazine page shares, drawn one way: the masthead, three skeleton rows while a
// page is fetched in the browser (a server-rendered page arrives finished), the signed-out door and
// the page that would not open.
import { createElement, type ReactElement, type ReactNode } from "react";
import type { Messages } from "../../lib/i18n.ts";
import { masthead } from "./view.ts";
import type { UiLocale } from "../../lib/i18n.ts";

/** The dated masthead: day and weekday on the left, `right` (issue number, project) on the right. */
export function mastheadEl(day: string, locale: UiLocale, right?: ReactNode): ReactElement {
  const head = masthead(day, locale);
  return createElement("div", { className: "mag-masthead" },
    createElement("div", { className: "mag-masthead-row" },
      createElement("div", { className: "mag-date" },
        createElement("span", null, head.date),
        createElement("span", { className: "mag-wd" }, head.weekday),
      ),
      createElement("div", { className: "mag-issue" }, right ?? null),
    ),
    createElement("div", { className: "mag-rule" }),
  );
}

/** Three rows the shape of the cards, while the page's data is on its way. */
export function skeletonRows(label: string): ReactElement {
  return createElement("div", { className: "mag-list", role: "status", "aria-label": label, "aria-busy": "true" },
    [["88%", "52%", "76%"], ["80%", "60%", "70%"], ["84%", "48%", "72%"]].map((w, i) =>
      createElement("div", { key: i, className: "sk-item" },
        createElement("div", { className: "sk-l", style: { width: w[0], height: 16 } }),
        createElement("div", { className: "sk-l", style: { width: w[1] } }),
        createElement("div", { className: "sk-l", style: { width: w[2] } }),
      ),
    ),
  );
}

/** Signed out: what the magazine is, and the two doors. */
export function signedOutEl(t: Messages): ReactElement {
  return createElement("div", { className: "mag-empty" },
    createElement("div", { className: "e-t" }, t.magazine.signedOut),
    createElement("a", { href: "/login", className: "e-cta" }, t.magazine.goToLogin),
    createElement("a", { href: "/register", className: "e-cta mt-2" }, t.magazine.goToRegister),
  );
}

/** The page would not open; `back` is a way out when there is a better place than here. */
export function failedEl(t: Messages, back?: { href: string; label: string }): ReactElement {
  return createElement("div", { className: "mag-empty" },
    createElement("div", { className: "e-t" }, t.magazine.failed),
    back ? createElement("a", { href: back.href, className: "e-cta mt-4" }, back.label) : null,
  );
}

/** The page frame: masthead, body, optional footer. */
export function magPage(parts: { head: ReactElement; body: ReactElement; foot?: ReactElement | null; empty?: boolean }): ReactElement {
  return createElement("div", { className: `magazine mag-page${parts.empty ? " mag-page-empty" : ""}` }, parts.head, parts.body, parts.foot ?? null);
}
