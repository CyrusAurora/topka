// The magazine's 设置 (master design B4): the account's own page — who's signed in, the per-user
// model keys (BYOK), the instance key story at a glance, project links and the sign-out / delete
// doors. Reads /api/auth/me, /api/me/keys and /api/projects with the visitor's session; the keys
// list shows last four characters only, never plaintext. A plain .ts factory for the node --test
// component tests; the route file is a thin shell.
import { createElement, useCallback, useEffect, useState, type FC, type ReactElement } from "react";
import { messages, problemMessage, useLocale, useT, type UiLocale } from "../../lib/i18n.ts";
import { zh } from "../../lib/locales/settings.ts";

export interface SettingsAccount {
  email: string;
  displayName: string | null;
  locale?: string;
  timezone?: string;
}

export interface SettingsKey {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  last4: string;
}

export interface SettingsKeyStatus {
  /** The instance can store readers' own keys (BYOK on). */
  configured: boolean;
  /** /api/me/model-status: who answers this reader's chat now; null when it could not be read. */
  model?: SettingsModelStatus | null;
}

export interface SettingsModelStatus {
  chat: "user-key" | "instance" | "none";
  reason: "model-calls-off" | "not-configured" | null;
  byokAvailable: boolean;
  userKey: { stored: boolean; usable: boolean; problem: "missing-base-url" | "missing-model" | null; last4: string | null };
}

/** The 「对话用的模型」 line, from the real status (not from whether keys can be stored). */
export function chatModelLine(status: SettingsModelStatus | null | undefined, locale: UiLocale = "zh-CN"): { text: string; tone: "ok" | "warn" } {
  const t = messages(locale).settings;
  if (!status) return { text: t.modelUnknown, tone: "warn" };
  if (status.chat === "user-key") return { text: `${t.modelUser}${status.userKey.last4 ? t.modelUserLast4(status.userKey.last4) : ""}`, tone: "ok" };
  if (status.chat === "instance") return { text: t.modelInstance, tone: "ok" };
  if (status.reason === "model-calls-off") return { text: t.modelOff, tone: "warn" };
  return { text: status.byokAvailable ? t.modelNoneByok : t.modelNone, tone: "warn" };
}

export interface SettingsProject {
  id: string;
  /** Short handle for links (/today/:slug); the API always gives one. */
  slug: string;
  target: string;
  purpose: string;
}

export interface SettingsView {
  phase: "loading" | "signed-out" | "failed" | "ready";
  account: SettingsAccount | null;
  keys: SettingsKey[];
  keyStatus: SettingsKeyStatus;
  projects: SettingsProject[];
}

export const SETTINGS_COPY = zh;

export interface SettingsPageProps {
  fetchImpl?: typeof fetch;
  /** After a successful delete the page may point the reader to the login door. */
  onDeleted?: () => void;
  /** After the language or time zone changes: the page is drawn again in it (default: reload). */
  onPrefsChanged?: () => void;
}

/** The IANA zones this browser knows, with the reader's current one kept even if it is not listed. */
export function timeZoneOptions(current: string): string[] {
  const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const list = known.length ? [...known] : ["Asia/Shanghai", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles", "UTC"];
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}

export const SettingsPage: FC<SettingsPageProps> = (props) => {
  const t = useT().settings;
  const locale = useLocale();
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const [view, setView] = useState<SettingsView>({
    phase: "loading",
    account: null,
    keys: [],
    keyStatus: { configured: false },
    projects: [],
  });
  const [logoutState, setLogoutState] = useState<"idle" | "sending" | "done">("idle");
  const [delState, setDelState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [delPassword, setDelPassword] = useState("");
  const [delError, setDelError] = useState<string | null>(null);
  const [keyProvider, setKeyProvider] = useState("llm");
  const [keyApi, setKeyApi] = useState("");
  const [keyBase, setKeyBase] = useState("");
  const [keyModel, setKeyModel] = useState("");
  const [feed, setFeed] = useState<{ enabled: boolean; url: string | null; state: "idle" | "sending" | "err"; copied: boolean }>({ enabled: false, url: null, state: "idle", copied: false });
  const [keyState, setKeyState] = useState<{ kind: "idle" | "sending" | "ok" | "err"; message?: string }>({ kind: "idle" });
  const [localeState, setLocaleState] = useState<{ kind: "idle" | "sending" | "ok" | "err" }>({ kind: "idle" });
  const prefsChanged = props.onPrefsChanged ?? (() => window.location.reload());

  const load = useCallback(async () => {
    try {
      const meRes = await doFetch("/api/auth/me");
      if (meRes.status === 401) {
        setView({ phase: "signed-out", account: null, keys: [], keyStatus: { configured: false }, projects: [] });
        return;
      }
      if (!meRes.ok) {
        setView({ phase: "failed", account: null, keys: [], keyStatus: { configured: false }, projects: [] });
        return;
      }
      const meBody = (await meRes.json()) as { user?: { email?: string; displayName?: string | null; locale?: string; timezone?: string } };
      const account: SettingsAccount = { email: meBody.user?.email ?? "", displayName: meBody.user?.displayName ?? null, locale: meBody.user?.locale ?? "zh-CN", timezone: meBody.user?.timezone ?? "Asia/Shanghai" };

      let keys: SettingsKey[] = [];
      let keyStatus: SettingsKeyStatus = { configured: false, model: null };
      try {
        const kRes = await doFetch("/api/me/keys");
        if (kRes.ok) {
          const kBody = (await kRes.json()) as { keys?: SettingsKey[]; encryptionConfigured?: boolean };
          keys = Array.isArray(kBody.keys) ? kBody.keys : [];
          keyStatus = { configured: kBody.encryptionConfigured === true, model: null };
        }
      } catch {
        // The keys panel just shows nothing; the rest of the page still works.
      }
      try {
        const sRes = await doFetch("/api/me/model-status");
        if (sRes.ok) keyStatus = { ...keyStatus, model: (await sRes.json()) as SettingsModelStatus };
      } catch {
        // The status line says it could not be read.
      }

      let projects: SettingsProject[] = [];
      try {
        const pRes = await doFetch("/api/projects");
        if (pRes.ok) {
          const pBody = (await pRes.json()) as { projects?: SettingsProject[] };
          projects = Array.isArray(pBody.projects) ? pBody.projects : [];
        }
      } catch {
        // The project list is optional; a failure leaves it empty.
      }

      try {
        const fRes = await doFetch("/api/me/issue-feed");
        if (fRes.ok) {
          const fBody = (await fRes.json()) as { enabled?: boolean };
          setFeed((cur) => ({ ...cur, enabled: fBody.enabled === true }));
        }
      } catch {
        // The reminder panel shows "off"; the rest still works.
      }

      setView({ phase: "ready", account, keys, keyStatus, projects });
    } catch {
      setView({ phase: "failed", account: null, keys: [], keyStatus: { configured: false }, projects: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const v = view;

  const logout = async () => {
    setLogoutState("sending");
    try {
      const res = await doFetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setLogoutState(res.ok ? "done" : "sending");
      if (res.ok) window.setTimeout(() => (props.onDeleted ? props.onDeleted() : window.location.assign("/login")), 400);
    } catch {
      setLogoutState("sending");
    }
  };

  const deleteAccount = async () => {
    if (delState === "sending" || delState === "done") return;
    setDelState("sending");
    setDelError(null);
    try {
      const res = await doFetch("/api/auth/delete-account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: delPassword }),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string; status?: number; retryAfter?: number };
        setDelState("error");
        setDelError(problemMessage(locale, problem, t.wrongPassword));
        return;
      }
      setDelState("done");
      window.setTimeout(() => (props.onDeleted ? props.onDeleted() : window.location.assign("/login")), 400);
    } catch {
      setDelState("error");
      setDelError(t.noNetworkDelete);
    }
  };

  const saveKey = async () => {
    if (keyState.kind === "sending") return;
    const provider = keyProvider.trim();
    if (!provider || !keyApi.trim() || !keyBase.trim()) return;
    setKeyState({ kind: "sending" });
    try {
      const res = await doFetch(`/api/me/keys/${encodeURIComponent(provider)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: keyApi.trim(),
          ...(keyBase.trim() ? { baseUrl: keyBase.trim() } : {}),
          ...(keyModel.trim() ? { model: keyModel.trim() } : {}),
        }),
      });
      if (res.ok) {
        setKeyState({ kind: "ok", message: t.keySaved });
        setKeyApi("");
        setKeyBase("");
        setKeyModel("");
        await load();
        return;
      }
      const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string; status?: number; retryAfter?: number };
      setKeyState({ kind: "err", message: problemMessage(locale, problem, t.saveFailed) });
    } catch {
      setKeyState({ kind: "err", message: t.noNetworkKey });
    }
  };

  const feedAction = async (method: "POST" | "DELETE") => {
    if (feed.state === "sending") return;
    setFeed((cur) => ({ ...cur, state: "sending", copied: false }));
    try {
      const res = await doFetch("/api/me/issue-feed", { method });
      if (!res.ok) return setFeed((cur) => ({ ...cur, state: "err" }));
      const body = (await res.json()) as { enabled?: boolean; url?: string };
      setFeed({ enabled: body.enabled === true, url: body.url ?? null, state: "idle", copied: false });
    } catch {
      setFeed((cur) => ({ ...cur, state: "err" }));
    }
  };

  const copyFeed = async () => {
    if (!feed.url) return;
    try {
      await navigator.clipboard.writeText(feed.url);
      setFeed((cur) => ({ ...cur, copied: true }));
    } catch {
      // The address is selectable on the page.
    }
  };

  const removeKey = async (provider: string) => {
    try {
      const res = await doFetch(`/api/me/keys/${encodeURIComponent(provider)}`, { method: "DELETE" });
      if (res.ok) {
        setKeyState({ kind: "ok", message: t.keyRemoved });
        await load();
      }
    } catch {
      // The key stays; the reader can retry.
    }
  };

  // Language and time zone go through the same PATCH; the page is drawn again in the new setting.
  const setPrefs = async (change: { locale?: string; timezone?: string }) => {
    if (localeState.kind === "sending") return;
    setLocaleState({ kind: "sending" });
    try {
      const res = await doFetch("/api/auth/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      if (res.ok) {
        setLocaleState({ kind: "ok" });
        await load();
        prefsChanged();
        return;
      }
      setLocaleState({ kind: "err" });
    } catch {
      setLocaleState({ kind: "err" });
    }
  };

  let body: ReactElement;
  if (v.phase === "loading") {
    body = createElement("p", { role: "status", className: "mag-note" }, t.loading);
  } else if (v.phase === "signed-out") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, t.signedOutTitle),
      createElement("a", { href: "/login", className: "e-cta" }, t.signedOutCta),
    );
  } else if (v.phase === "failed") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, t.loadFailed),
    );
  } else {
    const keyRows = v.keys.length
      ? createElement("div", { className: "settings-keylist" },
          createElement("div", { className: "settings-note" }, t.keyListSub),
          v.keys.map((k) =>
            createElement("div", { key: k.provider, className: "settings-row" },
              createElement("span", null, t.keyRow(k.provider, k.last4)),
              createElement("button", { type: "button", className: "hitlink", onClick: () => void removeKey(k.provider) }, t.removeKey),
            ),
          ),
        )
      : createElement("p", { className: "settings-note" }, t.noKeys);

    const projRows = v.projects.length
      ? createElement("div", { className: "settings-projs" },
          v.projects.map((p) =>
            createElement("a", { key: p.id, href: `/today/${encodeURIComponent(p.slug)}`, className: "settings-proj-row" },
              createElement("span", null, p.target),
              createElement("span", { className: "v" }, t.projectsToday),
            ),
          ),
          createElement("a", { href: "/projects/new", className: "settings-proj-row" },
            createElement("span", null, t.createProject),
            createElement("span", { className: "v" }, "+"),
          ),
        )
      : createElement("p", { className: "settings-note" }, t.noProjects);

    body = createElement("div", null,
      createElement("section", { className: "settings-section" },
        createElement("h2", null, t.accountHeading),
        createElement("div", { className: "settings-row" },
          createElement("span", null, t.emailLabel),
          createElement("span", { className: "v" }, v.account?.email ?? ""),
        ),
        createElement("div", { className: "settings-row" },
          createElement("span", null, t.localeLabel),
          createElement("span", {
            className: "v",
            "data-testid": "locale-current",
          }, v.account?.locale === "en" ? t.localeEn : t.localeZh),
        ),
        createElement("div", { className: "settings-actions" },
          createElement("button", {
            type: "button",
            "data-testid": "locale-zh",
            onClick: () => void setPrefs({ locale: "zh-CN" }),
            disabled: localeState.kind === "sending",
            className: v.account?.locale !== "en" ? "primary" : "",
          }, t.localeZh),
          createElement("button", {
            type: "button",
            "data-testid": "locale-en",
            onClick: () => void setPrefs({ locale: "en" }),
            disabled: localeState.kind === "sending",
            className: v.account?.locale === "en" ? "primary" : "",
          }, t.localeEn),
        ),
        createElement("div", { className: "settings-row" },
          createElement("label", { htmlFor: "time-zone" }, t.timeZoneLabel),
          createElement("select", {
            id: "time-zone",
            "data-testid": "timezone-select",
            className: "v",
            value: v.account?.timezone ?? "Asia/Shanghai",
            disabled: localeState.kind === "sending",
            onChange: (e: { target: { value: string } }) => void setPrefs({ timezone: e.target.value }),
          }, timeZoneOptions(v.account?.timezone ?? "Asia/Shanghai").map((z) => createElement("option", { key: z, value: z }, z))),
        ),
        createElement("p", { className: "settings-note" }, t.timeZoneHint),
        localeState.kind === "ok" ? createElement("p", { role: "status", className: "settings-msg ok" }, t.localeSaved) : null,
        localeState.kind === "err" ? createElement("p", { role: "alert", className: "settings-msg err" }, t.localeFailed) : null,
        createElement("div", { className: "settings-row" },
          createElement("span", null, t.instanceKey),
          createElement("span", { className: `v ${chatModelLine(v.keyStatus.model, locale).tone === "warn" ? "warn" : ""}`, "data-testid": "chat-model-status" }, chatModelLine(v.keyStatus.model, locale).text),
        ),
        createElement("div", { className: "settings-actions" },
          logoutState === "done"
            ? createElement("p", { role: "status", className: "settings-msg ok" }, t.logoutDone)
            : createElement("button", { type: "button", onClick: logout, disabled: logoutState === "sending" }, logoutState === "sending" ? t.logoutSending : t.logout),
        ),
      ),

      createElement("section", { className: "settings-section", id: "model-key" },
        createElement("h2", null, t.keysHeading),
        createElement("p", { className: "settings-note" }, t.keysSub),
        v.keyStatus.model?.userKey.problem
          ? createElement("p", { role: "alert", className: "settings-msg err" }, v.keyStatus.model.userKey.problem === "missing-base-url" ? t.keyMissingBase : t.keyMissingModel)
          : null,
        !v.keyStatus.configured ? createElement("p", { role: "alert", className: "settings-msg err" }, t.keyUnavailable) : createElement("div", { className: "settings-form" },
          createElement("div", { className: "field" },
            createElement("label", { htmlFor: "key-provider" }, t.providerLabel),
            createElement("input", { id: "key-provider", value: keyProvider, onChange: (e) => setKeyProvider(e.target.value), placeholder: "openai" }),
          ),
          createElement("div", { className: "field" },
            createElement("label", { htmlFor: "key-api" }, t.apiKeyLabel),
            createElement("input", { id: "key-api", type: "password", autoComplete: "off", value: keyApi, onChange: (e) => setKeyApi(e.target.value), placeholder: "sk-…" }),
          ),
          createElement("div", { className: "field" },
            createElement("label", { htmlFor: "key-base" }, t.baseUrlLabel),
            createElement("input", { id: "key-base", value: keyBase, onChange: (e) => setKeyBase(e.target.value), placeholder: "https://…" }),
          ),
          createElement("div", { className: "field" },
            createElement("label", { htmlFor: "key-model" }, t.modelLabel),
            createElement("input", { id: "key-model", value: keyModel, onChange: (e) => setKeyModel(e.target.value), placeholder: "gpt-4o-mini" }),
          ),
          createElement("div", { className: "settings-actions" },
            createElement("button", { type: "button", className: "primary", onClick: () => void saveKey(), disabled: keyState.kind === "sending" || !keyProvider.trim() || !keyApi.trim() || !keyBase.trim() }, keyState.kind === "sending" ? t.saveSending : t.saveKey),
          ),
          keyState.kind === "ok" ? createElement("p", { role: "status", className: "settings-msg ok" }, keyState.message ?? t.keySaved) : null,
          keyState.kind === "err" ? createElement("p", { role: "alert", className: "settings-msg err" }, keyState.message ?? t.saveFailed) : null,
        ),
        keyRows,
      ),

      createElement("section", { className: "settings-section", id: "reminder" },
        createElement("h2", null, t.feedHeading),
        createElement("p", { className: "settings-note" }, t.feedLead),
        createElement("div", { className: "settings-row" },
          createElement("span", null, t.feedStatusLabel),
          createElement("span", { className: "v", "data-testid": "feed-state" }, feed.enabled ? t.feedOn : t.feedOff),
        ),
        feed.url
          ? createElement("div", { className: "settings-form" },
              createElement("input", { readOnly: true, value: feed.url, "aria-label": t.feedUrlAria, "data-testid": "feed-url", onFocus: (e) => e.currentTarget.select() }),
              createElement("p", { className: "settings-note" }, t.feedOnce),
            )
          : null,
        createElement("div", { className: "settings-actions" },
          feed.url ? createElement("button", { type: "button", onClick: () => void copyFeed() }, feed.copied ? t.feedCopied : t.feedCopy) : null,
          createElement("button", { type: "button", className: feed.enabled ? "" : "primary", onClick: () => void feedAction("POST"), disabled: feed.state === "sending" }, feed.enabled ? t.feedRotate : t.feedEnable),
          feed.enabled ? createElement("button", { type: "button", onClick: () => void feedAction("DELETE"), disabled: feed.state === "sending" }, t.feedDisable) : null,
        ),
        feed.state === "err" ? createElement("p", { role: "alert", className: "settings-msg err" }, t.feedFailed) : null,
      ),

      createElement("section", { className: "settings-section" },
        createElement("h2", null, t.projectsHeading),
        projRows,
      ),

      createElement("section", { className: "settings-section danger" },
        createElement("h2", null, t.deleteHeading),
        createElement("p", { className: "settings-note" }, t.deleteLead),
        delState === "done"
          ? createElement("p", { role: "status", className: "settings-msg ok" }, t.deleteDone)
          : createElement("div", null,
              createElement("input", {
                type: "password",
                "aria-label": t.confirmPasswordAria,
                autoComplete: "current-password",
                value: delPassword,
                onChange: (e) => setDelPassword(e.target.value),
                disabled: delState === "sending",
                style: { display: "block", width: "100%", marginBottom: 8 },
              }),
              createElement("div", { className: "settings-actions" },
                createElement("button", { type: "button", className: "danger", onClick: () => void deleteAccount(), disabled: delState === "sending" || !delPassword }, delState === "sending" ? t.deleteSending : t.delete),
              ),
              delState === "error" && delError ? createElement("p", { role: "alert", className: "settings-msg err" }, delError) : null,
            ),
      ),
    );
  }

  return createElement("div", { className: "settings-page mx-auto w-full max-w-[560px] px-4 py-6" },
    createElement("div", { className: "settings-title" }, t.title),
    body,
  );
};
