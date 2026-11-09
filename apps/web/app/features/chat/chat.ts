// The magazine's 对话 (master design B3): the plain-words thread that creates, edits and deletes
// tracking projects — the same use case other clients reach, here over the
// instance's own HTTP door (A1, /api/me/chat*). A new ask runs the Socratic intake: one question per
// turn with tappable options (「其他」 types freely), a summarized question to confirm, then a judgement
// and a tracking card (real problem, what to track, key variables; the rest folded). Nothing
// changes until 确认. 再改改 / 取消 close the card; a quota reply offers 再发一次. A plain .ts
// factory for the node --test component tests; the route file is a thin shell.
// Web chat is instance-only: the assistant's model call is the user's BYOK key or the instance's
// free chain.
import { createElement, useCallback, useEffect, useRef, useState, type FC, type ReactElement } from "react";

/** One message of the thread (GET /api/me/chat, the post's own answer, or a local pending line). */
export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  clientId?: string;
  createdAt: number;
  turnStatus?: string;
  replyTo?: string;
  card?: ProposalCard | null;
  /** Intake turns: question / confirm / card / note, the tappable options and the summary block. */
  kind?: "question" | "confirm" | "card" | "note";
  chips?: string[];
  intake?: IntakeSummary;
  step?: number;
  /** Set on a message the page itself added while waiting for the server's answer. */
  pendingLocal?: boolean;
  /** A local line the server refused or never answered: shown dimmed, with 「再发一次」 below. */
  failed?: boolean;
}

export interface IntakeSummary { ask: string; problem: string; facts: string[]; assumptions: string[]; variables: string[]; question: string }
export interface IntakeBrief extends IntakeSummary { judgement: string; reasons: string[]; next: string }

/** The proposal card the assistant attaches, as the assistant's use case shapes it. */
export interface ProposalCard {
  id: string;
  kind: "create" | "update" | "delete";
  projectId: string | null;
  before: { target: string; purpose: string; focus: string; exclusions: string; sources: number } | null;
  payload: { target: string; purpose: string; focus: string; exclusions: string; sourceIds: string[]; intake?: IntakeBrief } | null;
  sources: { collecting: Array<{ id: string; name: string }>; pending: Array<{ id: string; name: string }> };
  warning: string | null;
  createdAt: string | null;
  status: string;
}

const CARD_TTL_MS = 24 * 3600 * 1000;

/** The server's quota / busy replies (project-assistant.quotaReply): the reader can send the last line again. */
const BUSY_REPLY = /免费额度用完了|没有可用的免费模型|模型这会儿.*忙|对话次数用完了|没想明白/;
const busy = (m: ChatMsg) => m.role === "assistant" && (m.turnStatus === "deferred" || BUSY_REPLY.test(m.text ?? ""));

/** Why a card has no buttons, in plain words. */
const CLOSED: Record<string, string> = {
  sending: "处理中……",
  applied: "已确认 ✓",
  superseded: "已被后面的新卡片替换",
  cancelled: "已放弃",
  expired: "已过期（超过 24 小时没确认）。再说一次就会出新卡片。",
  gone: "这个项目已经不在了",
  failed: "没能生效，再说一次试试",
  closed: "已关闭",
};

export const CHAT_COPY = {
  title: "对话",
  hint: "说一句想跟踪或想弄清楚什么，例如「帮我跟踪人形机器人」。我会问几个选择题，帮你把问题问准，确认后才会创建。",
  thinking: "正在想……",
  stuck: "消息已收到，后台暂时没连上。连上后会自动回复，不用重发。",
  notYet: "回复还没到。消息不会丢；也可以再发一次。",
  send: "发送",
  placeholder: "说说你想跟踪什么…",
  projects: "我的项目",
  noProjects: "还没有项目。直接说想跟踪什么就行。",
  sheetTip: "点一个项目，输入框会填上「修改…：」，接着说怎么改。",
  deleteProject: "删除",
  other: "其他",
  otherHint: "直接在下面输入你的情况…",
  more: "展开全部",
  signedOut: "登录后才能对话：对话会帮你建跟踪项目，项目跟着账号走。",
  login: "登录",
  register: "注册新账号",
  noModelKey: "还没有可用的模型。去「设置」填你自己的模型 Key（OpenAI 兼容，需要 Base URL），就能对话了。",
  noModelAdmin: "这个实例还没配置模型，也没开放「自带 Key」，对话暂时用不了。请联系管理员。",
  modelOff: "这个实例暂时关闭了模型调用，对话用不了。请稍后再试，或联系管理员。",
  toSettings: "去设置",
  failed: "这次没能答复，请稍后再试。",
  tooMany: "发得太快了，歇一会儿再发。",
  notSent: "没发出去",
  retry: "再发一次",
} as const;

/** Why the composer is closed: not signed in, or nothing can answer (with the way out). */
export type ChatGate = { kind: "signed-out" } | { kind: "no-model"; text: string; settings: boolean };

/** The /api/me/model-status answer, as far as the chat page reads it. */
export interface ModelStatusView { chat?: "user-key" | "instance" | "none"; reason?: string | null; byokAvailable?: boolean }

export function gateForStatus(status: ModelStatusView): ChatGate | null {
  if (status.chat !== "none") return null;
  if (status.reason === "model-calls-off") return { kind: "no-model", text: CHAT_COPY.modelOff, settings: false };
  return status.byokAvailable
    ? { kind: "no-model", text: CHAT_COPY.noModelKey, settings: true }
    : { kind: "no-model", text: CHAT_COPY.noModelAdmin, settings: false };
}

/** An intake card: the real problem, what to track and the key variables up front; the rest folded. */
function intakeCard(cv: Record<string, unknown>): ReactElement {
  const it = cv.intake as IntakeBrief;
  return createElement("span", { style: { display: "block" } },
    createElement("span", { className: "kv" },
      createElement("span", { className: "k" }, "真正的问题"), createElement("span", { className: "v" }, it.question || String(cv.purpose || "—")),
      createElement("span", { className: "k" }, "跟踪什么"), createElement("span", { className: "v" }, `${String(cv.target || "—")}${cv.focus && cv.focus !== "没有特别指定" ? `：${String(cv.focus)}` : ""}`),
      createElement("span", { className: "k" }, "关键变量"), createElement("span", { className: "v" }, list(it.variables)),
    ),
    createElement("details", { className: "chat-more" },
      createElement("summary", null, CHAT_COPY.more),
      createElement("span", { className: "kv" },
        createElement("span", { className: "k" }, "判断"), createElement("span", { className: "v" }, it.judgement || "—"),
        createElement("span", { className: "k" }, "理由"), createElement("span", { className: "v" }, list(it.reasons)),
        createElement("span", { className: "k" }, "下一步"), createElement("span", { className: "v" }, it.next || "—"),
        createElement("span", { className: "k" }, "已确认"), createElement("span", { className: "v" }, list(it.facts)),
        createElement("span", { className: "k" }, "待验证"), createElement("span", { className: "v" }, list(it.assumptions)),
        createElement("span", { className: "k" }, "排除"), createElement("span", { className: "v" }, String(cv.exclusions || "无")),
        createElement("span", { className: "k" }, "信源"), createElement("span", { className: "v" }, String(cv.sourcesText)),
      ),
    ),
  );
}

const list = (xs: string[] | undefined) => (xs && xs.length ? xs.join("；") : "—");

/** The summarized question's block under a confirm message: the question up front, the rest folded. */
function intakeBlock(it: IntakeSummary): ReactElement {
  return createElement("span", { className: "chat-intake" },
    createElement("span", { className: "iq" }, it.question),
    createElement("details", null,
      createElement("summary", null, "我是怎么整理的"),
      createElement("span", { className: "kv" },
        createElement("span", { className: "k" }, "你最初说"), createElement("span", { className: "v" }, it.ask || "—"),
        createElement("span", { className: "k" }, "真正的问题"), createElement("span", { className: "v" }, it.problem || "—"),
        createElement("span", { className: "k" }, "已确认"), createElement("span", { className: "v" }, list(it.facts)),
        createElement("span", { className: "k" }, "待验证"), createElement("span", { className: "v" }, list(it.assumptions)),
        createElement("span", { className: "k" }, "关键变量"), createElement("span", { className: "v" }, list(it.variables)),
      ),
    ),
  );
}

function cardViewOf(m: ChatMsg, latestCardId: string | null): Record<string, unknown> | null {
  const c = m.card;
  if (!c) return null;
  const p = c.payload ?? { target: "", purpose: "", focus: "", exclusions: "", sourceIds: [] as string[] };
  const collecting = c.sources?.collecting ?? [];
  const pending = c.sources?.pending ?? [];
  const names = [...collecting, ...pending].slice(0, 3).map((s) => s.name).join("、");
  const view: Record<string, unknown> = {
    id: c.id,
    kind: c.kind,
    title: c.kind === "create" ? "新建跟踪项目" : c.kind === "update" ? `修改「${c.before?.target ?? p.target ?? ""}」` : `删除「${c.before?.target ?? ""}」`,
    target: p.target ?? "",
    purpose: p.purpose ?? "",
    focus: p.focus ?? "没有特别指定",
    exclusions: p.exclusions ?? "无",
    sourcesText: collecting.length + pending.length
      ? `${collecting.length + pending.length} 个${pending.length ? `（${pending.length} 个待启用）` : ""}${names ? `：${names}${collecting.length + pending.length > 3 ? " 等" : ""}` : ""}`
      : "没有选到合适的信源",
    delPurpose: c.before?.purpose ?? "",
    delSources: c.before ? `${c.before.sources} 个绑定将解除` : "",
    warning: c.warning,
    intake: p.intake ?? null,
    confirmLabel: c.kind === "create" ? "确认创建" : c.kind === "update" ? "确认修改" : "确认删除",
    reviseLabel: c.kind === "delete" ? "取消" : "再改改",
  };
  let status = c.status || "proposed";
  if (status === "proposed" && c.createdAt && Date.now() - new Date(c.createdAt).getTime() > CARD_TTL_MS) status = "expired";
  if (status === "proposed" && c.id !== latestCardId) status = "superseded";
  view.status = status;
  view.open = status === "proposed";
  view.closedText = CLOSED[status] ?? CLOSED.closed;
  view.closedTone = status === "applied" ? "ok" : status === "sending" ? "" : "off";
  return view;
}

export interface ChatPageProps {
  /** Read the thread's start here (the 今日 card's 「不想再看到…」 lands as ?prefill=…). */
  initialText?: string;
  /** The /api/me/chat* endpoints are cookie-authenticated; the test harness swaps the fetch. */
  fetchImpl?: typeof fetch;
  /** How long one send may take before the page stops waiting on the request (then it polls). */
  postTimeoutMs?: number;
  /** How long the poll after a lost request waits for the answer before offering 「再发一次」. */
  pollWindowMs?: number;
  /** Poll spacing (tests shorten it). */
  pollEveryMs?: number;
}

function gateBanner(gate: ChatGate): ReactElement {
  if (gate.kind === "signed-out") {
    return createElement("div", { role: "alert", className: "chat-gate" },
      createElement("p", null, CHAT_COPY.signedOut),
      createElement("span", { className: "btns" },
        createElement("a", { href: "/login?next=%2Fchat", className: "btn dark" }, CHAT_COPY.login),
        createElement("a", { href: "/register", className: "btn" }, CHAT_COPY.register),
      ),
    );
  }
  return createElement("div", { role: "alert", className: "chat-gate" },
    createElement("p", null, gate.text),
    gate.settings ? createElement("span", { className: "btns" }, createElement("a", { href: "/settings#model-key", className: "btn dark" }, CHAT_COPY.toSettings)) : null,
  );
}

export const ChatPage: FC<ChatPageProps> = (props) => {
  const doFetch = props.fetchImpl ?? fetch.bind(globalThis);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; target: string; purpose: string; focus: string; exclusions: string }>>([]);
  const [input, setInput] = useState(() => (props.initialText ?? "").trim());
  const [waiting, setWaiting] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [gate, setGate] = useState<ChatGate | null>(null);
  const [retry, setRetry] = useState<{ clientId: string; text: string } | null>(null);
  const postTimeoutMs = props.postTimeoutMs ?? 45_000;
  const pollWindowMs = props.pollWindowMs ?? 90_000;
  const pollEveryMs = props.pollEveryMs ?? 2000;
  const afterRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await doFetch("/api/projects");
      if (!res.ok) return;
      const body = (await res.json()) as { projects?: Array<{ id: string; target: string; purpose: string; focus?: string; exclusions?: string }> };
      const list = Array.isArray(body.projects) ? body.projects : [];
      setProjects(list.map((p) => ({ id: p.id, target: p.target, purpose: p.purpose, focus: p.focus ?? "", exclusions: p.exclusions ?? "" })));
    } catch {
      // The sheet is optional; a failure just leaves it empty.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchThread = useCallback(async (): Promise<ChatMsg[]> => {
    try {
      const res = await doFetch(`/api/me/chat${afterRef.current ? `?after=${afterRef.current}` : ""}`);
      if (res.status === 401) {
        setGate({ kind: "signed-out" });
        setWaiting(false);
        return [];
      }
      if (!res.ok) return [];
      const body = (await res.json()) as { messages?: ChatMsg[] };
      const fresh = (Array.isArray(body.messages) ? body.messages : []).filter(
        (m) => !messages.some((x) => x.role === "user" && m.role === "user" && m.clientId != null && x.clientId === m.clientId && x.pendingLocal),
      );
      if (!fresh.length) return [];
      afterRef.current = Math.max(afterRef.current, ...fresh.map((m) => m.createdAt || 0));
      setMessages((cur) => {
        const next = [...cur];
        for (const f of fresh) {
          const i = next.findIndex((x) => x.role === "user" && x.pendingLocal && f.role === "user" && f.clientId != null && x.clientId === f.clientId);
          if (i >= 0) next.splice(i, 1);
          next.push(f);
        }
        // A real answer replaces the "still waiting" note; a busy reply with its user line stays retryable.
        return next;
      });
      setWaiting(false);
      setNote(null);
      return fresh;
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await doFetch("/api/me/model-status");
      if (res.status === 401) return setGate({ kind: "signed-out" });
      if (!res.ok) return;
      const g = gateForStatus((await res.json()) as ModelStatusView);
      if (g) setGate((cur) => cur ?? g);
    } catch {
      // Unknown: let the reader try; the send itself answers honestly.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async () => {
    void Promise.all([fetchThread(), loadProjects(), loadStatus()]);
  }, [fetchThread, loadProjects, loadStatus]);

  useEffect(() => {
    void start();
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Poll until the awaited answer lands; an answer nobody picked up in 15s or none in the window gets an honest note and 「再发一次」. */
  const waitFor = useCallback(
    async (done: (m: ChatMsg) => boolean, lost?: { clientId: string; text: string }) => {
      stopPoll();
      const since = Date.now();
      const until = since + pollWindowMs;
      let noted = false;
      setWaiting(true);
      const tick = async () => {
        const fresh = await fetchThread();
        if (fresh.some(done)) {
          setWaiting(false);
          stopPoll();
          void loadProjects();
          return;
        }
        if (!noted && Date.now() - since > 15_000) {
          noted = true;
          setNote(CHAT_COPY.stuck);
        }
        if (Date.now() > until) {
          setWaiting(false);
          stopPoll();
          setNote(CHAT_COPY.notYet);
          if (lost) {
            setMessages((cur) => cur.map((m) => (m.clientId === lost.clientId && m.role === "user" && m.pendingLocal ? { ...m, failed: true } : m)));
            setRetry(lost);
          }
          return;
        }
        pollRef.current = setTimeout(tick, pollEveryMs);
      };
      pollRef.current = setTimeout(tick, Math.min(1500, pollEveryMs));
    },
    [fetchThread, stopPoll, loadProjects, pollWindowMs, pollEveryMs],
  );

  const markFailed = (clientId: string) =>
    setMessages((cur) => cur.map((m) => (m.role === "user" && m.clientId === clientId ? { ...m, pendingLocal: false, failed: true } : m)));

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || sending || waiting || gate) return;
    const clientId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    setInput("");
    setMessages((cur) => [...cur, { role: "user", text, clientId, createdAt: Date.now(), pendingLocal: true }]);
    setNote(null);
    setRetry(null);
    setSending(true);
    // The server answers inline; a request that is lost or runs past postTimeoutMs falls back to the
    // thread poll (the turn may still land), which itself gives up with 「再发一次」.
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), postTimeoutMs) : null;
    try {
      const res = await doFetch("/api/me/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, clientId }),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) {
        // The server answered "no": say why at once; never wait on a turn that will not come.
        const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
        setSending(false);
        markFailed(clientId);
        if (res.status === 401) return setGate({ kind: "signed-out" });
        if (res.status === 409 && problem.code === "no_model") {
          void loadStatus();
          return setGate({ kind: "no-model", text: problem.detail || CHAT_COPY.noModelKey, settings: /设置/.test(problem.detail ?? "设置") });
        }
        setNote(res.status === 429 ? problem.detail || CHAT_COPY.tooMany : problem.detail || CHAT_COPY.failed);
        setRetry({ clientId, text });
        return;
      }
      {
        const body = (await res.json()) as { reply?: string; status?: string; card?: ProposalCard | null; kind?: ChatMsg["kind"]; chips?: string[]; intake?: IntakeSummary; step?: number };
        // Fast answer: no poll needed; append it and any card now.
        setMessages((cur) => [
          ...cur.map((m) => (m.pendingLocal && m.clientId === clientId ? { ...m, pendingLocal: false } : m)),
          {
            role: "assistant", text: body.reply ?? "", turnStatus: body.status, replyTo: clientId, createdAt: Date.now() + 1, card: body.card ?? null,
            ...(body.kind ? { kind: body.kind } : {}), ...(body.chips ? { chips: body.chips } : {}), ...(body.intake ? { intake: body.intake } : {}), ...(body.step ? { step: body.step } : {}),
          },
        ]);
        setSending(false);
        setWaiting(false);
        return;
      }
    } catch {
      // No answer inline (network, or past postTimeoutMs): the turn may still land; poll for it.
    }
    if (timer) clearTimeout(timer);
    setSending(false);
    await waitFor((m) => m.role === "assistant" && m.replyTo === clientId, { clientId, text });
  };

  const resend = async (userText: string, failedClientId?: string) => {
    if (failedClientId) setMessages((cur) => cur.filter((m) => !(m.role === "user" && m.clientId === failedClientId && m.failed)));
    setRetry(null);
    await send(userText);
  };

  const inputRef = useRef<HTMLInputElement | null>(null);
  const pick = (chip: string) => {
    if (chip === CHAT_COPY.other) {
      setNote(CHAT_COPY.otherHint);
      inputRef.current?.focus();
      return;
    }
    void send(chip);
  };

  const decide = async (cardId: string, act: "confirm" | "cancel") => {
    try {
      const res = await doFetch(`/api/me/chat/${act}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: cardId }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { ok?: boolean; state?: string; message?: string };
      setMessages((cur) =>
        cur.map((m) => {
          if (m.role !== "assistant" || m.card?.id !== cardId) return m;
          const status = body.ok ? "applied" : body.state ?? "closed";
          return { ...m, card: m.card ? { ...m.card, status, warning: body.ok ? null : m.card.warning } : null };
        }),
      );
      if (body.ok) void loadProjects();
    } catch {
      // The card stays; a retry is a tap away.
    }
  };

  const deleteProject = async (projectId: string) => {
    try {
      const res = await doFetch("/api/me/chat/delete-proposal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { card?: ProposalCard | null };
      if (body.card) {
        setMessages((cur) => [...cur, { role: "assistant", text: `确认删除「${body.card?.before?.target ?? ""}」吗？`, createdAt: Date.now(), card: body.card ?? null }]);
      }
    } catch {
      // The list's delete stays a no-op on failure.
    }
  };

  const editProject = (target: string) => {
    setShowProjects(false);
    setInput(`修改「${target}」：`);
  };

  const cards = messages.filter((m) => m.card);
  const latestCardId = cards.length ? cards[cards.length - 1]!.card!.id : null;
  const sent = new Map<string, string>();
  for (const m of messages) if (m.role === "user" && m.clientId) sent.set(m.clientId, m.text);

  const lastIndex = messages.length - 1;
  const body: ReactElement[] = messages.map((m, index) => {
    const cv = m.card ? cardViewOf(m, latestCardId) : null;
    const key = m.clientId ?? `m${m.createdAt}`;
    const isBusy = busy(m);
    const retryText = isBusy && m.replyTo ? sent.get(m.replyTo) : undefined;
    return createElement("div", { key, className: "chat-msg", id: `m-${key}` },
      m.role === "user"
        ? createElement("span", { className: `u ${m.failed ? "failed" : ""}` }, m.text,
            m.failed ? createElement("span", { className: "chat-failed" }, ` · ${CHAT_COPY.notSent}`) : null)
        : createElement("span", { className: `a ${isBusy ? "note" : ""}` },
            m.text ? createElement("span", { style: { whiteSpace: "pre-line" } }, m.text) : null,
            m.intake ? intakeBlock(m.intake) : null,
            m.chips && m.chips.length && index === lastIndex && !waiting && !sending
              ? createElement("span", { className: "chat-chips" },
                  m.chips.map((c) => createElement("button", { key: c, type: "button", className: `chip ${c === CHAT_COPY.other ? "other" : ""}`, onClick: () => pick(c) }, c)))
              : null,
            cv ? createElement("span", { className: `chat-card ${cv.kind === "delete" ? "danger" : ""} ${cv.open || cv.status === "sending" || cv.status === "applied" ? "" : "dim"}`, style: { display: "block", marginTop: 8 } },
                createElement("span", { className: "ct" }, String(cv.title)),
                cv.intake
                  ? intakeCard(cv)
                  : cv.kind !== "delete"
                  ? createElement("span", { className: "kv" },
                      createElement("span", { className: "k" }, "对象"), createElement("span", { className: "v" }, String(cv.target || "—")),
                      createElement("span", { className: "k" }, "目标"), createElement("span", { className: "v" }, String(cv.purpose || "—")),
                      createElement("span", { className: "k" }, "关注重点"), createElement("span", { className: "v" }, String(cv.focus)),
                      createElement("span", { className: "k" }, "排除"), createElement("span", { className: "v" }, String(cv.exclusions)),
                      createElement("span", { className: "k" }, "信源"), createElement("span", { className: "v" }, String(cv.sourcesText)),
                    )
                  : createElement("span", { className: "kv" },
                      createElement("span", { className: "k" }, "目标"), createElement("span", { className: "v" }, String(cv.delPurpose || "—")),
                      String(cv.delSources) ? createElement("span", { className: "k" }, "信源") : null,
                      String(cv.delSources) ? createElement("span", { className: "v" }, String(cv.delSources)) : null,
                    ),
                cv.warning ? createElement("span", { className: "warn" }, String(cv.warning)) : null,
                cv.open
                  ? createElement("span", { className: "btns" },
                      createElement("button", { type: "button", className: "btn", onClick: () => void decide(String(cv.id), "cancel") }, String(cv.reviseLabel)),
                      createElement("button", { type: "button", className: `btn ${cv.kind === "delete" ? "red" : "dark"}`, onClick: () => void decide(String(cv.id), "confirm") }, String(cv.confirmLabel)),
                    )
                  : createElement("span", { className: `closed ${cv.closedTone === "ok" ? "ok" : ""}` }, String(cv.closedText)),
              )
            : null,
            retryText ? createElement("button", { type: "button", className: "chat-retry", onClick: () => void resend(retryText) }, "再发一次") : null,
          ),
    );
  });

  return createElement("div", { className: "chat-shell mx-auto w-full max-w-[560px] px-4 py-6" },
    createElement("div", { className: "chat-title" }, CHAT_COPY.title),
    createElement("button", { type: "button", className: "chat-projbar", onClick: () => setShowProjects((s) => !s) }, `我的项目（${projects.length}）`),
    createElement("div", { className: "chat-list" },
      !messages.length && !waiting ? createElement("p", { className: "chat-hint" }, CHAT_COPY.hint) : null,
      ...body,
      waiting ? createElement("p", { className: "chat-msg" }, createElement("span", { className: "a thinking" }, CHAT_COPY.thinking)) : null,
      note ? createElement("p", { role: "status", className: "chat-note" }, note) : null,
      retry && !waiting && !sending && !gate
        ? createElement("button", { type: "button", className: "chat-retry", onClick: () => void resend(retry.text, retry.clientId) }, CHAT_COPY.retry)
        : null,
      gate ? gateBanner(gate) : null,
    ),
    createElement("div", { className: "chat-inputbar" },
      createElement("input", {
        ref: inputRef,
        value: input,
        onChange: (e) => setInput(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        },
        placeholder: CHAT_COPY.placeholder,
        maxLength: 500,
        disabled: sending || !!gate,
      }),
      createElement("button", { type: "button", onClick: () => void send(), disabled: !input.trim() || sending || waiting || !!gate }, sending ? "…" : CHAT_COPY.send),
    ),
    showProjects ? createElement("div", { className: "chat-sheet-mask", onClick: () => setShowProjects(false) },
      createElement("div", { className: "chat-sheet", onClick: (e) => e.stopPropagation() },
        createElement("div", { className: "chat-sheet-head" },
          createElement("span", null, CHAT_COPY.projects),
          createElement("span", { className: "count" }, `${projects.length} 个`),
        ),
        projects.length === 0 ? createElement("p", { className: "chat-empty" }, CHAT_COPY.noProjects) : createElement("div", { className: "chat-proj-list" },
          projects.map((p) =>
            createElement("div", { key: p.id, className: "chat-proj-card" },
              createElement("button", { type: "button", className: "pname", onClick: () => editProject(p.target) }, p.target),
              p.purpose ? createElement("p", { className: "ppurpose" }, p.purpose) : null,
              createElement("div", { className: "pfoot" },
                createElement("span", { className: "pmeta" }, ""),
                createElement("button", { type: "button", className: "pdel", onClick: () => void deleteProject(p.id) }, CHAT_COPY.deleteProject),
              ),
            ),
          ),
        ),
        createElement("p", { className: "chat-sheet-tip" }, CHAT_COPY.sheetTip),
      ),
    ) : null,
  );
};
