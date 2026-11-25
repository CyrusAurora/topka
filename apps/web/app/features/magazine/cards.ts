// The card list of 今日 and of a single past issue: one row per item, opened in place, the summary,
// the source and the copy button. Both pages draw it from here, with the same open/copy/read state.
import { createElement, useState, type KeyboardEvent, type ReactElement } from "react";
import type { Messages, UiLocale } from "../../lib/i18n.ts";
import { contentLangAttr, metaNodes, sourceLink, type CardRow } from "./view.ts";

/** Which card is open, which link was just copied, and the read marks this visit added. */
export function useCardState(doFetch: typeof fetch) {
  const [openId, setOpenId] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [readSet, setReadSet] = useState<Set<string>>(() => new Set());
  const expand = (row: CardRow) => {
    if (openId === row.id) {
      setOpenId("");
      return;
    }
    setOpenId(row.id);
    if (!row.read && !readSet.has(row.id)) {
      setReadSet((prev) => new Set(prev).add(row.id));
      // The server marks the item read; a failure is not the reader's problem.
      void doFetch("/api/me/issues/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleId: row.id }),
      }).catch(() => {});
    }
  };
  const copy = async (row: CardRow) => {
    try {
      await navigator.clipboard.writeText(row.url);
      setCopiedId(row.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === row.id ? "" : cur)), 1500);
    } catch {
      // Clipboard unavailable; the link is right there.
    }
  };
  const reset = () => {
    setOpenId("");
    setCopiedId("");
    setReadSet(new Set());
  };
  return { openId, copiedId, readSet, expand, copy, close: () => setOpenId(""), reset };
}

export type CardState = ReturnType<typeof useCardState>;

export function cardList(opts: { rows: CardRow[]; state: CardState; t: Messages; locale: UiLocale; contentLang?: string; hero?: boolean; muteLinks?: boolean }): ReactElement {
  const { rows, state, t, locale, contentLang } = opts;
  return createElement("div", { className: "mag-list" },
    rows.map((row, i) => {
      const open = state.openId === row.id;
      const hero = opts.hero === true && i === 0 && rows.length === 3;
      const read = row.read || state.readSet.has(row.id);
      return createElement("article", { key: row.id, className: `mag-item${hero ? " hero" : ""}${read ? " read" : ""}${open ? " open" : ""}` },
        createElement("div", {
          className: "m-row-t",
          onClick: () => state.expand(row),
          role: "button",
          tabIndex: 0,
          "aria-expanded": open,
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              state.expand(row);
            }
          },
        },
          createElement("span", { className: "m-num", "aria-hidden": "true" }, row.no),
          createElement("div", { className: "m-body" },
            createElement("div", { className: "m-t" }, createElement("span", { lang: contentLangAttr(contentLang, locale, row.title) }, row.title), row.ledger ? createElement("span", { className: "m-ledger", "data-ledger": row.ledger }, ` · ${row.ledger}`) : null),
            row.core ? createElement("div", { className: "m-why", lang: contentLangAttr(contentLang, locale, row.core) }, row.core) : null,
            createElement("div", { className: "m-meta" },
              createElement("span", { className: "m-src" }, ...metaNodes(row.source || t.magazine.unknownSource, row.when, row.multi && row.project ? row.project : null, locale)),
              createElement("span", { className: "m-tog" }, open ? t.magazine.collapse : t.magazine.expand),
            ),
          ),
        ),
        open ? createElement("div", { className: "m-more" },
          createElement("div", { className: "m-more-in" },
            createElement("div", { className: "m-more-pad" },
              row.summary
                ? createElement("div", { className: "m-sum", lang: contentLangAttr(contentLang, locale, row.summary) }, row.summary)
                : createElement("div", { className: "m-sum muted" }, t.magazine.summaryPending),
              createElement("div", { className: "m-src-row" },
                sourceLink(row.url, row.host, t.magazine.openOriginal(row.host)),
                createElement("button", {
                  type: "button",
                  className: `m-copy hit ${state.copiedId === row.id ? "done" : ""}`,
                  onClick: () => void state.copy(row),
                }, state.copiedId === row.id ? t.magazine.copied : t.magazine.copyLink),
              ),
              createElement("div", { className: "m-acts" },
                opts.muteLinks && row.tag
                  ? createElement("a", { className: "m-mute hit", href: `/chat?prefill=${encodeURIComponent(t.magazine.muteTopicPrefill(row.tag))}` }, t.magazine.muteTopic(row.tag))
                  : null,
                createElement("button", { type: "button", className: "m-close hit", onClick: state.close }, t.magazine.collapse),
              ),
            ),
          ),
        ) : null,
      );
    }),
  );
}
