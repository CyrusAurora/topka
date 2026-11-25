// Card copy is written in two halves (title_a + title_b, core_a + core_b) and shown as one line on the
// web, in the issue feed and in the demo export. Full-width punctuation already
// carries its own space, so a space next to it reads as a double gap ("框架：  人形"). Every place that
// stores or shows card copy goes through these two functions.

/** Full-width punctuation: CJK marks and the full-width forms of ASCII signs. */
const FULL_WIDTH = "，。：；、！？（）【】「」『』《》〈〉“”‘’…—～·";
const NO_GAP_AFTER = new RegExp(`[${FULL_WIDTH},:(\\[]$`);
const NO_GAP_BEFORE = new RegExp(`^[${FULL_WIDTH},.:;!?)\\]]`);
const SPACE_AROUND = new RegExp(`\\s*([${FULL_WIDTH}])\\s*`, "g");

/** One field of card copy: whitespace to one space, none next to full-width punctuation, trimmed. */
export function tidyCopy(s: string | null | undefined): string {
  return String(s ?? "").replace(/\s+/g, " ").replace(SPACE_AROUND, "$1").trim();
}

/** Whether a space goes between two halves: not when either side meets punctuation. */
export function halvesGap(a: string, b: string): boolean {
  return !NO_GAP_AFTER.test(a) && !NO_GAP_BEFORE.test(b);
}

/** Two halves as one line. */
export function joinHalves(a: string | null | undefined, b: string | null | undefined): string {
  const x = tidyCopy(a);
  const y = tidyCopy(b);
  if (!x || !y) return x || y;
  return halvesGap(x, y) ? `${x} ${y}` : `${x}${y}`;
}
