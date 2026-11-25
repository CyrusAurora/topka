export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number, ellipsis = "…"): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - ellipsis.length)).join("").trimEnd() + ellipsis;
}

export function stripTags(html: string): string {
  return collapseWhitespace(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      // Last, so "&amp;lt;" reads "&lt;" (what the page showed), not "<".
      .replace(/&amp;/g, "&"),
  );
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}
