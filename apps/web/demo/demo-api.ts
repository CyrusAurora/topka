// The online demo's stand-in for the API (GitHub Pages has no server). Reading answers come from the
// exported JSON of a real instance (scripts/pages-export.ts); 对话 and project creation run the
// built-in demo model in the browser (demo-chat.ts); anything that needs an account or a server says
// so, in the page's language, and links the self-hosting docs. Nothing leaves the browser.
import { chatTurn, decideCard, emptyChat, type ChatState, type DemoProject, type DemoSource } from "./demo-chat.ts";

export const SELF_HOST_URL = "https://github.com/CyrusAurora/topka/blob/main/docs/self-hosting.md";

export interface DemoPrefs { locale: "zh-CN" | "en"; timeZone: string }
export interface DemoStore { get(key: string): string | null; set(key: string, value: string): void }
export interface DemoPack { id: string; label: string; labelEn: string | null; sources: Array<{ id: string; name: string; publisher: string | null; regions: string[] }> }

export interface DemoEnv {
  /** The exported data: "today.json", "issues.json", "issues/<date>.json"; null when missing. */
  data(path: string): Promise<unknown | null>;
  store: DemoStore;
  prefs(): DemoPrefs;
  setPrefs(p: Partial<DemoPrefs>): void;
  packs: DemoPack[];
  now?: () => number;
}

const DEMO_TEXT = {
  "zh-CN": {
    needsServer: "这是在线体验版：这个操作要在你自己部署的 Topka 上做（见 docs/self-hosting.md）。",
    keys: "在线体验版不保存模型 Key。自己部署 Topka 后，在「设置」里填你的 Key。",
    projectEmptyTitle: "在线体验版不采集",
    projectEmptyDetail: "这里的项目只存在你的浏览器里。采集和分析要在自己部署的 Topka 上开。",
    realProjectTitle: "这个项目的真实精选在「今日」和「往期」",
    realProjectDetail: "在线体验版只公开每天定稿的 3 条，不公开项目的完整信息流。",
    footNote: "在线体验：显示供数据的实例最近定稿的一期",
  },
  en: {
    needsServer: "This is the online demo: this needs a self-hosted Topka (see docs/self-hosting.md).",
    keys: "The online demo stores no model keys. Self-host Topka and add your key in Settings.",
    projectEmptyTitle: "The online demo does not collect",
    projectEmptyDetail: "Projects here live only in your browser. Collection and analysis run on a self-hosted Topka.",
    realProjectTitle: "This project's real picks are on Today and Past issues",
    realProjectDetail: "The online demo publishes only the 3 picks fixed each day, not the project's full feed.",
    footNote: "Online demo: the latest issue the feeding instance fixed",
  },
} as const;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status: number, code: string, detail: string) =>
  new Response(JSON.stringify({ type: "about:blank", title: code, status, code, detail }), { status, headers: { "content-type": "application/problem+json" } });

function readJson<T>(store: DemoStore, key: string, fallback: T): T {
  try {
    const raw = store.get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
const writeJson = (store: DemoStore, key: string, value: unknown) => store.set(key, JSON.stringify(value));

const K = { reads: "topka-demo:reads", chat: "topka-demo:chat", projects: "topka-demo:projects", packPrefs: "topka-demo:pack-prefs" };

export function createDemoApi(env: DemoEnv): (input: string, init?: RequestInit) => Promise<Response> {
  const now = env.now ?? (() => Date.now());
  const catalog = (): DemoSource[] => {
    const seen = new Map<string, DemoSource>();
    for (const p of env.packs) for (const s of p.sources) if (!seen.has(s.id)) seen.set(s.id, { id: s.id, name: s.name });
    return [...seen.values()];
  };
  const realProjects = async (): Promise<DemoProject[]> => {
    const today = (await env.data("today.json")) as { projects?: Array<{ id: string; slug: string; target: string }>; generatedAt?: string } | null;
    return (today?.projects ?? []).map((p) => ({ id: p.id, slug: p.slug, target: p.target, purpose: "", focus: "", exclusions: "", sourceIds: [], createdAt: today?.generatedAt ?? "", local: false }));
  };
  const localProjects = () => readJson<DemoProject[]>(env.store, K.projects, []);
  const allProjects = async () => [...(await realProjects()), ...localProjects()];
  const user = () => {
    const p = env.prefs();
    return { id: "demo", email: "reader@example.com", displayName: p.locale === "en" ? "Demo reader" : "体验读者", locale: p.locale, timezone: p.timeZone, role: "user" };
  };
  const text = () => DEMO_TEXT[env.prefs().locale];
  const bodyOf = (init?: RequestInit): Record<string, unknown> => {
    try {
      return typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  return async (input, init) => {
    const url = new URL(input, "https://demo.invalid");
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const read = (file: string) => env.data(file);

    if (method === "GET" && path === "/api/me/today") {
      const today = (await read("today.json")) as Record<string, unknown> | null;
      if (!today) return problem(503, "temporarily_unavailable", text().needsServer);
      return json({ ...today, opened: readJson<string[]>(env.store, K.reads, []), footNote: text().footNote });
    }
    if (method === "GET" && path === "/api/me/issues") {
      const issues = await read("issues.json");
      return issues ? json(issues) : json({ archive: [], issueCount: 0 });
    }
    const issueAt = /^\/api\/me\/issues\/(\d{4}-\d{2}-\d{2})$/.exec(path);
    if (method === "GET" && issueAt) {
      const issue = await read(`issues/${issueAt[1]}.json`);
      return issue ? json(issue) : json({ error: "not-found" }, 404);
    }
    if (method === "POST" && (path === "/api/me/issues/read" || path === "/api/me/today/mark")) {
      const id = String(bodyOf(init).articleId ?? "");
      if (id) writeJson(env.store, K.reads, [...new Set([...readJson<string[]>(env.store, K.reads, []), id])]);
      return json({ ok: true });
    }
    if (method === "POST" && path === "/api/me/today/ack") return json({ checkpoint: null });

    if (path === "/api/auth/me" && (method === "GET" || method === "PATCH")) {
      if (method === "PATCH") {
        const b = bodyOf(init);
        env.setPrefs({
          ...(b.locale === "en" || b.locale === "zh-CN" ? { locale: b.locale } : {}),
          ...(typeof b.timezone === "string" ? { timeZone: b.timezone } : {}),
        });
      }
      return json({ user: user() });
    }
    if (method === "GET" && path === "/api/me/model-status") {
      return json({ chat: "instance", reason: null, instance: { available: true, reason: null, via: "demo" }, byokAvailable: false, userKey: { stored: false, usable: false, problem: null, last4: null } });
    }
    if (method === "GET" && path === "/api/me/keys") return json({ keys: [], encryptionConfigured: false });
    if (path.startsWith("/api/me/keys/")) return problem(403, "demo", text().keys);
    if (method === "GET" && path === "/api/me/issue-feed") return json({ enabled: false, createdAt: null, lastReadAt: null });

    // 对话
    if (method === "GET" && path === "/api/me/chat") {
      const after = Number(url.searchParams.get("after") ?? 0);
      return json({ messages: readJson<ChatState>(env.store, K.chat, emptyChat()).messages.filter((m) => m.createdAt > after) });
    }
    if (method === "POST" && path === "/api/me/chat") {
      const b = bodyOf(init);
      const lang = env.prefs().locale === "en" ? "en" : "zh";
      const { state, answer } = chatTurn(readJson<ChatState>(env.store, K.chat, emptyChat()), String(b.text ?? ""), {
        lang, projects: await allProjects(), catalog: catalog(), now: now(), clientId: b.clientId ? String(b.clientId) : undefined,
      });
      writeJson(env.store, K.chat, state);
      return json(answer);
    }
    const decide = /^\/api\/me\/chat\/(confirm|cancel)$/.exec(path);
    if (method === "POST" && decide) {
      const r = decideCard(readJson<ChatState>(env.store, K.chat, emptyChat()), String(bodyOf(init).proposalId ?? ""), decide[1] as "confirm" | "cancel", localProjects(), now());
      writeJson(env.store, K.chat, r.state);
      writeJson(env.store, K.projects, r.projects);
      return json(r.body);
    }
    if (method === "POST" && path === "/api/me/chat/delete-proposal") {
      const target = localProjects().find((p) => p.id === String(bodyOf(init).projectId ?? ""));
      if (!target) return problem(403, "demo", text().needsServer);
      const state = readJson<ChatState>(env.store, K.chat, emptyChat());
      const id = `demo-card-del-${now()}`;
      const card = { id, kind: "delete" as const, projectId: target.id, before: { target: target.target, purpose: target.purpose, focus: target.focus, exclusions: target.exclusions, sources: target.sourceIds.length }, payload: null, sources: { collecting: [], pending: [] }, warning: "delete", createdAt: new Date(now()).toISOString(), status: "proposed" };
      writeJson(env.store, K.chat, { ...state, cards: { ...state.cards, [id]: card } });
      return json({ card });
    }

    // Projects and the wizard
    if (method === "GET" && path === "/api/projects") {
      return json({ projects: (await allProjects()).map((p) => ({ id: p.id, slug: p.slug, target: p.target, purpose: p.purpose, focus: p.focus, exclusions: p.exclusions, status: "active", currentRevision: 1, createdAt: p.createdAt, sources: p.sourceIds.length })) });
    }
    if (method === "POST" && path === "/api/projects") {
      const b = bodyOf(init);
      const list = localProjects();
      const n = list.length + 1;
      const project: DemoProject = {
        id: `local-${n}-${now()}`, slug: `local-${n}-${now()}`, target: String(b.target ?? "").slice(0, 80), purpose: String(b.purpose ?? "").slice(0, 400),
        focus: String(b.focus ?? ""), exclusions: String(b.exclusions ?? ""), sourceIds: Array.isArray(b.sourceIds) ? b.sourceIds.map(String) : [], createdAt: new Date(now()).toISOString(), local: true,
      };
      writeJson(env.store, K.projects, [...list, project]);
      return json({ project: { id: project.id, slug: project.slug, target: project.target, purpose: project.purpose }, created: true }, 201);
    }
    const projectToday = /^\/api\/projects\/([^/]+)\/today$/.exec(path);
    if (method === "GET" && projectToday) {
      const slug = decodeURIComponent(projectToday[1]!);
      const p = (await allProjects()).find((x) => x.slug === slug || x.id === slug);
      if (!p) return problem(404, "not_found", text().needsServer);
      const until = new Date(now());
      return json({
        kind: "project-today",
        project: { id: p.id, slug: p.slug, target: p.target, purpose: p.purpose },
        window: { since: new Date(until.getTime() - 86_400_000).toISOString(), until: until.toISOString(), basis: "default" },
        checkpoint: { readThrough: null },
        sources: { linked: p.sourceIds.length, active: 0, scheduled: 0, collectionOn: false, analysisOn: false },
        cardCount: 3, quietDay: true, result: "no-important-change",
        emptyState: p.local ? { title: text().projectEmptyTitle, detail: text().projectEmptyDetail } : { title: text().realProjectTitle, detail: text().realProjectDetail },
        items: [], awaitingAnalysis: 0, notice: "",
      });
    }
    if (method === "GET" && path.startsWith("/api/packs")) {
      return json({ packs: env.packs.map((p) => ({ ...p, available: true, reason: null })), instance: { collectionOn: false, analysisOn: false } });
    }
    if (path === "/api/pack-prefs") {
      if (method === "PUT") {
        writeJson(env.store, K.packPrefs, bodyOf(init));
        return json({});
      }
      return json(readJson(env.store, K.packPrefs, { packId: null, picks: [] }));
    }

    // Accounts, reminders, deletion, feedback: a server's job.
    return problem(403, "demo", text().needsServer);
  };
}

/** Routes window.fetch("/api/…") to the demo API; every other request goes out unchanged. */
export function installDemoFetch(api: (input: string, init?: RequestInit) => Promise<Response>, target: { fetch: typeof fetch } = globalThis): void {
  const original = target.fetch.bind(target);
  target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = raw.startsWith("/") ? raw : (() => {
      try {
        const u = new URL(raw);
        return typeof location !== "undefined" && u.origin === location.origin ? `${u.pathname}${u.search}` : "";
      } catch {
        return "";
      }
    })();
    if (path.startsWith("/api/")) return api(path, init);
    return original(input, init);
  }) as typeof fetch;
}
