// Text from outside (a source's title, body, author and name; a reader's chat message) reaches the
// models as data, framed by markers the prompts define: tag fences such as <material>…</material>
// and <input>…</input>, and bracketed section labels such as 【用户这次说】 or 【内容 id=…】. Text that
// carries one of those markers itself could end the data early, or pose as another item or as a
// "verified" section, and have the rest read as instructions. Before untrusted text goes into a
// prompt it is made inert: fence-like tags become ‹…›, 【】 become 〔〕, and invisible control
// characters that could hide either are dropped. The wording itself is kept, so the model can still
// summarise an article that is *about* prompt injection (tests/prompt-injection.test.ts).

/** Tag names the prompts use as fences, and the chat-role names a forged fence would pick. */
const FENCE_NAMES = ["source", "material", "input", "system", "user", "assistant", "developer", "instructions?", "project", "context", "tool", "function", "im_start", "im_end"];
const FENCE = new RegExp(`[<＜]\\s*(/?)\\s*(${FENCE_NAMES.join("|")})\\b([^<>＜＞\\n]{0,200})[>＞]`, "giu");
/** Zero-width characters, bidirectional overrides and the BOM. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/** Fence-like tags only (for a prompt whose framing around the text is our own). */
export function inertTags(text: string): string {
  return text.replace(INVISIBLE, "").replace(FENCE, (_m, slash: string, name: string, rest: string) => `‹${slash}${name}${rest}›`);
}

/** Untrusted text as it may appear inside a prompt. */
export function inert(text: string): string;
export function inert(text: string | null): string | null;
export function inert(text: string | null | undefined): string | null | undefined;
export function inert(text: string | null | undefined): string | null | undefined {
  if (typeof text !== "string") return text;
  return inertTags(text).replace(/【/g, "〔").replace(/】/g, "〕");
}

/** Every string inside a JSON value made inert (a stored post with its quoted post and media notes). */
export function inertDeep<T>(value: T): T {
  if (typeof value === "string") return inert(value) as T;
  if (Array.isArray(value)) return value.map((v) => inertDeep(v)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inertDeep(v)])) as T;
  return value;
}

/** A short untrusted label (a source or project name) on one line. */
export function inertLine(text: string | null | undefined, max: number): string {
  return inert(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}
