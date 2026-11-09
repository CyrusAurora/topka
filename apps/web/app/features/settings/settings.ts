// The magazine's 设置 (master design B4): the account's own page — who's signed in, the per-user
// model keys (BYOK), the instance key story at a glance, project links and the sign-out / delete
// doors. Reads /api/auth/me, /api/me/keys and /api/projects with the visitor's session; the keys
// list shows last four characters only, never plaintext. A plain .ts factory for the node --test
// component tests; the route file is a thin shell.
import { createElement, useCallback, useEffect, useState, type FC, type ReactElement } from "react";

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
export function chatModelLine(status: SettingsModelStatus | null | undefined): { text: string; tone: "ok" | "warn" } {
  if (!status) return { text: SETTINGS_COPY.modelUnknown, tone: "warn" };
  if (status.chat === "user-key") return { text: `${SETTINGS_COPY.modelUser}${status.userKey.last4 ? `（…${status.userKey.last4}）` : ""}`, tone: "ok" };
  if (status.chat === "instance") return { text: SETTINGS_COPY.modelInstance, tone: "ok" };
  if (status.reason === "model-calls-off") return { text: SETTINGS_COPY.modelOff, tone: "warn" };
  return { text: status.byokAvailable ? SETTINGS_COPY.modelNoneByok : SETTINGS_COPY.modelNone, tone: "warn" };
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

export const SETTINGS_COPY = {
  title: "设置",
  accountHeading: "账号",
  localeLabel: "界面语言",
  localeZh: "简体中文",
  localeEn: "English",
  localeSaved: "已保存。",
  localeFailed: "保存没有成功。",
  logout: "退出登录",
  logoutDone: "已退出登录。",
  deleteHeading: "注销账号",
  deleteLead: "注销会删掉账号、项目和对话记录，无法恢复。输入密码确认。",
  delete: "注销账号",
  deleteDone: "账号已注销。",
  wrongPassword: "密码不对，注销不了。",
  keysHeading: "自带的模型 Key",
  keysSub: "填你自己的 OpenAI 兼容 Key（要有 Base URL），你的对话优先用它；没填就用实例配置的模型（如果有）。只显示后四位。",
  keyUnavailable: "这个实例没开放「自带 Key」：请改用实例的模型，或让管理员设置 KEY_ENCRYPTION_SECRET。",
  providerLabel: "provider（字母、数字、连字符）",
  apiKeyLabel: "Key",
  baseUrlLabel: "Base URL（必填，公网 https 地址，例如 https://api.openai.com/v1）",
  modelLabel: "模型（例如 gpt-4o-mini；留空用实例默认）",
  saveKey: "保存",
  keySaved: "已保存。",
  keyRemoved: "已删除。",
  noKeys: "还没有 Key。",
  keyListSub: "当前保存的 Key：",
  instanceKey: "对话用的模型",
  modelUser: "你自己的 Key",
  modelInstance: "实例的模型（可用）",
  modelOff: "不可用：这个实例关闭了模型调用",
  modelNoneByok: "没有可用的模型：在下面填你自己的 Key 就能对话",
  modelNone: "没有可用的模型：实例没配置，也没开放自带 Key",
  modelUnknown: "暂时读不到模型状态",
  keyMissingBase: "已保存的 Key 缺 Base URL，对话还用不上它：删掉后带上 Base URL 重新保存。",
  keyMissingModel: "已保存的 Key 没填模型，实例也没有默认模型：删掉后带上模型名重新保存。",
  feedHeading: "每日提醒（订阅源）",
  feedLead: "每天 08:00（台北时间）固定的 3 件会出现在一个只属于你的 Atom 订阅地址里：放进任意 RSS 阅读器（Feedly、Inoreader、NetNewsWire、Reeder…），新一期一到就提醒你。不发邮件、不推送。",
  feedOff: "还没开。",
  feedOn: "已开启",
  feedEnable: "生成订阅地址",
  feedRotate: "换一个地址",
  feedDisable: "关闭",
  feedCopy: "复制",
  feedCopied: "已复制",
  feedOnce: "这个地址只显示这一次，别分享给别人；丢了就「换一个地址」，旧地址立即失效。",
  feedFailed: "没能完成，请稍后再试。",
  projectsHeading: "项目",
  noProjects: "还没有项目。",
  projectsToday: "项目今日",
  createProject: "新建项目",
} as const;

export interface SettingsPageProps {
  fetchImpl?: typeof fetch;
  /** After a successful delete the page may point the reader to the login door. */
  onDeleted?: () => void;
}

export const SettingsPage: FC<SettingsPageProps> = (props) => {
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
        const problem = (await res.json().catch(() => ({}))) as { detail?: string };
        setDelState("error");
        setDelError(problem.detail ?? SETTINGS_COPY.wrongPassword);
        return;
      }
      setDelState("done");
      window.setTimeout(() => (props.onDeleted ? props.onDeleted() : window.location.assign("/login")), 400);
    } catch {
      setDelState("error");
      setDelError("没网，注销没有完成。");
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
        setKeyState({ kind: "ok", message: SETTINGS_COPY.keySaved });
        setKeyApi("");
        setKeyBase("");
        setKeyModel("");
        await load();
        return;
      }
      const problem = (await res.json().catch(() => ({}))) as { detail?: string };
      setKeyState({ kind: "err", message: problem.detail ?? "保存没有成功。" });
    } catch {
      setKeyState({ kind: "err", message: "没网，Key 没有保存。" });
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
        setKeyState({ kind: "ok", message: SETTINGS_COPY.keyRemoved });
        await load();
      }
    } catch {
      // The key stays; the reader can retry.
    }
  };

  const setLocale = async (locale: string) => {
    if (localeState.kind === "sending") return;
    setLocaleState({ kind: "sending" });
    try {
      const res = await doFetch("/api/auth/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      if (res.ok) {
        setLocaleState({ kind: "ok" });
        await load();
        return;
      }
      setLocaleState({ kind: "err" });
    } catch {
      setLocaleState({ kind: "err" });
    }
  };

  let body: ReactElement;
  if (v.phase === "loading") {
    body = createElement("p", { role: "status", className: "mag-note" }, "正在读设置……");
  } else if (v.phase === "signed-out") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, "请先登录。"),
      createElement("a", { href: "/login", className: "e-cta" }, "去登录"),
    );
  } else if (v.phase === "failed") {
    body = createElement("div", { className: "mag-empty" },
      createElement("div", { className: "e-t" }, "设置暂时打不开，请稍后再试。"),
    );
  } else {
    const keyRows = v.keys.length
      ? createElement("div", { className: "settings-keylist" },
          createElement("div", { className: "settings-note" }, SETTINGS_COPY.keyListSub),
          v.keys.map((k) =>
            createElement("div", { key: k.provider, className: "settings-row" },
              createElement("span", null, `${k.provider}（${k.last4}）`),
              createElement("button", { type: "button", className: "hitlink", onClick: () => void removeKey(k.provider) }, "删除"),
            ),
          ),
        )
      : createElement("p", { className: "settings-note" }, SETTINGS_COPY.noKeys);

    const projRows = v.projects.length
      ? createElement("div", { className: "settings-projs" },
          v.projects.map((p) =>
            createElement("a", { key: p.id, href: `/today/${encodeURIComponent(p.slug)}`, className: "settings-proj-row" },
              createElement("span", null, p.target),
              createElement("span", { className: "v" }, SETTINGS_COPY.projectsToday),
            ),
          ),
          createElement("a", { href: "/projects/new", className: "settings-proj-row" },
            createElement("span", null, SETTINGS_COPY.createProject),
            createElement("span", { className: "v" }, "+"),
          ),
        )
      : createElement("p", { className: "settings-note" }, SETTINGS_COPY.noProjects);

    body = createElement("div", null,
      createElement("section", { className: "settings-section" },
        createElement("h2", null, SETTINGS_COPY.accountHeading),
        createElement("div", { className: "settings-row" },
          createElement("span", null, "邮箱"),
          createElement("span", { className: "v" }, v.account?.email ?? ""),
        ),
        createElement("div", { className: "settings-row" },
          createElement("span", null, SETTINGS_COPY.localeLabel),
          createElement("span", {
            className: "v",
            "data-testid": "locale-current",
          }, v.account?.locale === "en" ? SETTINGS_COPY.localeEn : SETTINGS_COPY.localeZh),
        ),
        createElement("div", { className: "settings-actions" },
          createElement("button", {
            type: "button",
            "data-testid": "locale-zh",
            onClick: () => void setLocale("zh-CN"),
            disabled: localeState.kind === "sending",
            className: v.account?.locale !== "en" ? "primary" : "",
          }, SETTINGS_COPY.localeZh),
          createElement("button", {
            type: "button",
            "data-testid": "locale-en",
            onClick: () => void setLocale("en"),
            disabled: localeState.kind === "sending",
            className: v.account?.locale === "en" ? "primary" : "",
          }, SETTINGS_COPY.localeEn),
        ),
        localeState.kind === "ok" ? createElement("p", { role: "status", className: "settings-msg ok" }, SETTINGS_COPY.localeSaved) : null,
        localeState.kind === "err" ? createElement("p", { role: "alert", className: "settings-msg err" }, SETTINGS_COPY.localeFailed) : null,
        createElement("div", { className: "settings-row" },
          createElement("span", null, SETTINGS_COPY.instanceKey),
          createElement("span", { className: `v ${chatModelLine(v.keyStatus.model).tone === "warn" ? "warn" : ""}`, "data-testid": "chat-model-status" }, chatModelLine(v.keyStatus.model).text),
        ),
        createElement("div", { className: "settings-actions" },
          logoutState === "done"
            ? createElement("p", { role: "status", className: "settings-msg ok" }, SETTINGS_COPY.logoutDone)
            : createElement("button", { type: "button", onClick: logout, disabled: logoutState === "sending" }, logoutState === "sending" ? "正在退出…" : SETTINGS_COPY.logout),
        ),
      ),

      createElement("section", { className: "settings-section", id: "model-key" },
        createElement("h2", null, SETTINGS_COPY.keysHeading),
        createElement("p", { className: "settings-note" }, SETTINGS_COPY.keysSub),
        v.keyStatus.model?.userKey.problem
          ? createElement("p", { role: "alert", className: "settings-msg err" }, v.keyStatus.model.userKey.problem === "missing-base-url" ? SETTINGS_COPY.keyMissingBase : SETTINGS_COPY.keyMissingModel)
          : null,
        !v.keyStatus.configured ? createElement("p", { role: "alert", className: "settings-msg err" }, SETTINGS_COPY.keyUnavailable) : createElement("div", { className: "settings-form" },
          createElement("div", { className: "field" },
            createElement("label", { htmlFor: "key-provider" }, SETTINGS_COPY.providerLabel),
            createElement("input", { id: "key-provider", value: keyProvider, onChange: (e) => setKeyProvider(e.target.value), placeholder: "openai" }),
          ),
          createElement("div", { className: "field" },
            createElement("label", { htmlFor: "key-api" }, SETTINGS_COPY.apiKeyLabel),
            createElement("input", { id: "key-api", type: "password", autoComplete: "off", value: keyApi, onChange: (e) => setKeyApi(e.target.value), placeholder: "sk-…" }),
          ),
          createElement("div", { className: "field" },
            createElement("label", { htmlFor: "key-base" }, SETTINGS_COPY.baseUrlLabel),
            createElement("input", { id: "key-base", value: keyBase, onChange: (e) => setKeyBase(e.target.value), placeholder: "https://…" }),
          ),
          createElement("div", { className: "field" },
            createElement("label", { htmlFor: "key-model" }, SETTINGS_COPY.modelLabel),
            createElement("input", { id: "key-model", value: keyModel, onChange: (e) => setKeyModel(e.target.value), placeholder: "gpt-4o-mini" }),
          ),
          createElement("div", { className: "settings-actions" },
            createElement("button", { type: "button", className: "primary", onClick: () => void saveKey(), disabled: keyState.kind === "sending" || !keyProvider.trim() || !keyApi.trim() || !keyBase.trim() }, keyState.kind === "sending" ? "正在保存…" : SETTINGS_COPY.saveKey),
          ),
          keyState.kind === "ok" ? createElement("p", { role: "status", className: "settings-msg ok" }, keyState.message ?? SETTINGS_COPY.keySaved) : null,
          keyState.kind === "err" ? createElement("p", { role: "alert", className: "settings-msg err" }, keyState.message ?? "保存没有成功。") : null,
        ),
        keyRows,
      ),

      createElement("section", { className: "settings-section", id: "reminder" },
        createElement("h2", null, SETTINGS_COPY.feedHeading),
        createElement("p", { className: "settings-note" }, SETTINGS_COPY.feedLead),
        createElement("div", { className: "settings-row" },
          createElement("span", null, "状态"),
          createElement("span", { className: "v", "data-testid": "feed-state" }, feed.enabled ? SETTINGS_COPY.feedOn : SETTINGS_COPY.feedOff),
        ),
        feed.url
          ? createElement("div", { className: "settings-form" },
              createElement("input", { readOnly: true, value: feed.url, "aria-label": "订阅地址", "data-testid": "feed-url", onFocus: (e) => e.currentTarget.select() }),
              createElement("p", { className: "settings-note" }, SETTINGS_COPY.feedOnce),
            )
          : null,
        createElement("div", { className: "settings-actions" },
          feed.url ? createElement("button", { type: "button", onClick: () => void copyFeed() }, feed.copied ? SETTINGS_COPY.feedCopied : SETTINGS_COPY.feedCopy) : null,
          createElement("button", { type: "button", className: feed.enabled ? "" : "primary", onClick: () => void feedAction("POST"), disabled: feed.state === "sending" }, feed.enabled ? SETTINGS_COPY.feedRotate : SETTINGS_COPY.feedEnable),
          feed.enabled ? createElement("button", { type: "button", onClick: () => void feedAction("DELETE"), disabled: feed.state === "sending" }, SETTINGS_COPY.feedDisable) : null,
        ),
        feed.state === "err" ? createElement("p", { role: "alert", className: "settings-msg err" }, SETTINGS_COPY.feedFailed) : null,
      ),

      createElement("section", { className: "settings-section" },
        createElement("h2", null, SETTINGS_COPY.projectsHeading),
        projRows,
      ),

      createElement("section", { className: "settings-section danger" },
        createElement("h2", null, SETTINGS_COPY.deleteHeading),
        createElement("p", { className: "settings-note" }, SETTINGS_COPY.deleteLead),
        delState === "done"
          ? createElement("p", { role: "status", className: "settings-msg ok" }, SETTINGS_COPY.deleteDone)
          : createElement("div", null,
              createElement("input", {
                type: "password",
                "aria-label": "确认密码",
                autoComplete: "current-password",
                value: delPassword,
                onChange: (e) => setDelPassword(e.target.value),
                disabled: delState === "sending",
                style: { display: "block", width: "100%", marginBottom: 8 },
              }),
              createElement("div", { className: "settings-actions" },
                createElement("button", { type: "button", className: "danger", onClick: () => void deleteAccount(), disabled: delState === "sending" || !delPassword }, delState === "sending" ? "正在注销…" : SETTINGS_COPY.delete),
              ),
              delState === "error" && delError ? createElement("p", { role: "alert", className: "settings-msg err" }, delError) : null,
            ),
      ),
    );
  }

  return createElement("div", { className: "settings-page mx-auto w-full max-w-[560px] px-4 py-6" },
    createElement("div", { className: "settings-title" }, SETTINGS_COPY.title),
    body,
  );
};
