// The project assistant's HTTP door (web 对话建项目): the same use case other clients reach
// (assistant/project-assistant.ts) — a session cookie instead of an external identity.
// A message runs one Socratic intake turn (or, for change/delete, the one-shot assistant); a create card
// only comes after the user confirmed the summarized question, and nothing changes until confirm applies it. The thread
// answers the recent assistant turns (user lines from assistant_turns, the assistant's answers from
// the turns' own rows), with a proposal card attached wherever one is open.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "@topka/backend/db";
import { parseCookies } from "@topka/backend/admin/auth";
import { resolveSession, SESSION_COOKIE } from "@topka/backend/accounts/session";
import {
  cancelProposal,
  confirmProposal,
  loadCard,
  proposeDelete,
  type ProposalCard,
  type TurnMeta,
} from "@topka/backend/assistant/project-assistant";
import { chatTurn, closeIntake, type IntakeTurnResult } from "@topka/backend/assistant/intake";
import { modelStatus } from "@topka/backend/providers/availability";
import { sendProblem } from "../http/respond.ts";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  clientId?: string;
  createdAt: number;
  turnStatus?: string;
  replyTo?: string;
  card?: ProposalCard | null;
  /** Intake turns: question / confirm / card / note, the tappable options and the summary block. */
  kind?: TurnMeta["kind"];
  chips?: string[];
  intake?: TurnMeta["intake"];
  step?: number;
}

const metaFields = (meta: TurnMeta | null | undefined) => (meta ? { kind: meta.kind, ...(meta.chips ? { chips: meta.chips } : {}), ...(meta.intake ? { intake: meta.intake } : {}), ...(meta.step ? { step: meta.step } : {}) } : {});

async function sessionOf(req: FastifyRequest) {
  return resolveSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

// A burst guard per user on top of the daily turn cap: every message may spend a free-model call,
// and the shared free quota is the instance's, so one account cannot drain it in a minute.
const chatTries = new Map<string, number[]>();
function chatLimited(userId: string): boolean {
  const cap = Number(process.env.CHAT_PER_MINUTE ?? 8);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const now = Date.now();
  if (chatTries.size > 5000) chatTries.clear();
  const list = (chatTries.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= cap) return true;
  list.push(now);
  chatTries.set(userId, list);
  return false;
}
/** Test hook: forget the chat windows. */
export function resetChatLimits(): void {
  chatTries.clear();
}

export function registerAssistant(app: FastifyInstance) {
  // The recent thread, newest first. `after` (a message's createdAt in ms) answers the poll the web
  // page opens right after a command: only what landed since is re-sent.
  app.get("/api/me/chat", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const raw = req.raw.url ?? "";
    const qIndex = raw.indexOf("?");
    const after = qIndex >= 0 ? Number(new URLSearchParams(raw.slice(qIndex + 1)).get("after")) : 0;
    const afterMs = Number.isFinite(after) && after > 0 ? after : 0;
    const turns = await sql<{
      id: number;
      user_text: string;
      client_id: string | null;
      reply_text: string | null;
      proposal_id: string | null;
      status: string;
      meta: TurnMeta | null;
      created_at: Date;
    }[]>`
      SELECT id, user_text, client_id, reply_text, proposal_id, status, meta, created_at
      FROM assistant_turns WHERE user_id = ${user.id}
      ${afterMs ? sql.unsafe(`AND created_at > to_timestamp(${afterMs / 1000})`) : sql.unsafe("AND id > 0")}
      ORDER BY id DESC LIMIT 50`;
    const messages: ChatMessage[] = [];
    for (const turn of turns.reverse()) {
      const at = turn.created_at.getTime();
      const client = turn.client_id ?? undefined;
      messages.push({ role: "user", text: turn.user_text, ...(client ? { clientId: client } : {}), createdAt: at });
      const card = turn.proposal_id ? await loadCard(user.id, turn.proposal_id) : null;
      messages.push({
        role: "assistant",
        text: turn.reply_text ?? "",
        createdAt: at + 1,
        turnStatus: turn.status,
        ...(client ? { replyTo: client } : {}),
        card,
        ...metaFields(turn.meta),
      });
    }
    // A card no recent turn carries (the oldest one in the window, or one made after the poll began)
    // still shows while open: the newest one, attached to the last assistant message.
    const open = await sql<{ id: string; created_at: Date }[]>`SELECT id, created_at FROM project_proposals WHERE user_id = ${user.id} AND status = 'proposed' ORDER BY created_at`;
    if (open.length && !messages.some((m) => m.role === "assistant" && m.card?.id)) {
      const card = await loadCard(user.id, open[open.length - 1]!.id);
      if (card) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]!.role === "assistant") { messages[i]!.card = card; break; }
        }
      }
    }
    return { messages };
  });

  app.post("/api/me/chat", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = String(b.text ?? "").trim();
    const clientId = b.clientId !== undefined && b.clientId !== null && String(b.clientId) !== "" ? String(b.clientId) : undefined;
    if (!text) return sendProblem(req, reply, { status: 400, code: "text_required", detail: "说点什么吧。" });
    if (chatLimited(user.id)) return sendProblem(req, reply, { status: 429, code: "rate_limited", detail: "发得太快了，等一分钟再发。", retryAfter: 60 });
    // Nothing can answer (no key of the reader's own, no instance model): say so now, with the way out,
    // instead of a turn that can only fail.
    const status = await modelStatus(user.id);
    if (status.chat === "none") {
      const detail = status.reason === "model-calls-off"
        ? "这个实例暂时关闭了模型调用，对话用不了。请稍后再试，或联系管理员。"
        : status.byokAvailable
          ? "还没有可用的模型：去「设置」填你自己的模型 Key（OpenAI 兼容，需要 Base URL），就能对话了。"
          : "这个实例还没配置模型，也没开放「自带 Key」，对话暂时用不了。请联系管理员。";
      return sendProblem(req, reply, { status: 409, code: "no_model", detail });
    }
    let turn: IntakeTurnResult;
    try {
      turn = await chatTurn(user.id, text, { clientId });
    } catch (error) {
      req.log.error({ err: error }, "assistant turn failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "这次没能答复，请稍后再试。" });
    }
    return { reply: turn.reply, status: turn.status, card: turn.card, turnId: turn.turnId, ...metaFields(turn.meta) };
  });

  app.post("/api/me/chat/confirm", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const proposalId = String(b.proposalId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(proposalId)) return sendProblem(req, reply, { status: 400, code: "proposal_required", detail: "缺 proposalId。" });
    const out = await confirmProposal(user.id, proposalId);
    if (out.ok) await closeIntake(user.id, proposalId);
    if (!out.ok && out.reason === "not-found") {
      return sendProblem(req, reply, { status: 404, code: "not_found", detail: "找不到这张卡片。" });
    }
    return out.ok
      ? { ok: true, kind: out.kind, projectId: out.projectId, message: out.message, proposalId }
      : { ok: false, state: out.state, message: out.message, proposalId };
  });

  app.post("/api/me/chat/cancel", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const proposalId = String(b.proposalId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(proposalId)) return sendProblem(req, reply, { status: 400, code: "proposal_required", detail: "缺 proposalId。" });
    const out = await cancelProposal(user.id, proposalId);
    return { ok: out.ok, state: out.state, message: out.message, proposalId };
  });

  app.post("/api/me/chat/delete-proposal", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await sessionOf(req);
    if (!user) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录。" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const projectId = String(b.projectId ?? "");
    if (!projectId) return sendProblem(req, reply, { status: 400, code: "project_required", detail: "缺 projectId。" });
    const card = await proposeDelete(user.id, projectId);
    if (!card) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个项目。" });
    return { card };
  });
}
