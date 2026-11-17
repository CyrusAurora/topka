// Types for intake-core.cjs (the shared Socratic intake state machine).
declare namespace core {
  export interface IntakeSummary { ask: string; problem: string; facts: string[]; assumptions: string[]; variables: string[]; question: string }
  export interface IntakeTurn { q: string; options: string[]; a: string | null }
  export interface IntakeSession {
    v: number; stage: "asking" | "confirm" | "card" | "done"; ask: string; turns: IntakeTurn[]; asked: number;
    analysis: Record<string, string[]> | null; summary: IntakeSummary | null; corrections: string[];
    card: { proposal: IntakeProposal; id?: string } | null; startedAt: number; updatedAt: number;
    /** The reader's language when the session started; absent means Chinese. */
    lang?: "en";
  }
  export interface IntakeBrief extends IntakeSummary { judgement: string; reasons: string[]; next: string }
  export interface IntakeProposal { target: string; purpose: string; focus: string; exclusions: string; sourceIds: string[]; intake: IntakeBrief }
  export type IntakeMode = "ask" | "summarize" | "card";
  export interface IntakeMessage { kind: "question" | "confirm" | "card" | "note"; text: string; update?: string; question?: string; chips?: string[]; intake?: IntakeSummary; step?: number }
  export type IntakePlan =
    | { mode: IntakeMode; session: IntakeSession }
    | { mode: "local"; session: IntakeSession | null; reply: IntakeMessage };
  export interface IntakeContext { projects?: string[]; catalog?: Array<{ id: string; name: string; enabled: boolean }>; validSource?: (id: string) => boolean }
  export type IntakeApplied =
    | { session: IntakeSession; message: IntakeMessage; proposal?: IntakeProposal; manage?: undefined }
    | { manage: true; session: null };
}
declare const core: {
  VERSION: number; MAX_QUESTIONS: number; SESSION_TTL_MS: number; OTHER: string; CONFIRM_YES: string; CONFIRM_NO: string; RESTART: string; UNAVAILABLE: string;
  TEXT: Record<"zh" | "en", { other: string; yes: string; no: string; restarted: string; cancelled: string; whatsWrong: string; unavailable: string; join: string }>;
  unavailableIn(lang: string | null | undefined): string;
  routeOf(text: string): "manage" | "intake";
  /** "取消" / "never mind": ends an unfinished interview. */
  isCancel(text: string): boolean;
  /** "帮我跟踪…" / "Track …": a new request, not an answer to the open question. */
  isNewAsk(text: string): boolean;
  /** `lang` ("en" or Chinese otherwise) applies when this turn starts a new session. */
  planTurn(session: core.IntakeSession | null, text: string, now: number, lang?: string | null): core.IntakePlan;
  buildUser(mode: core.IntakeMode, session: core.IntakeSession, ctx?: core.IntakeContext): string;
  parseJson(text: string): unknown;
  applyAnswer(mode: core.IntakeMode, session: core.IntakeSession, answer: unknown, ctx?: core.IntakeContext): core.IntakeApplied | null;
  finish(session: core.IntakeSession | null, now: number): core.IntakeSession | null;
  live(session: core.IntakeSession | null, now: number): boolean;
  isYes(text: string): boolean;
};
export = core;
