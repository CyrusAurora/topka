// Server half of lib/reader-data.ts: a reader page's loader asks the api for the page's GETs with the
// reader's session, so the HTML that arrives is the finished page. Only the reader session cookie is
// forwarded (never admin_session or the visitor id), as in the root loader.
import type { Responses } from "./reader-data";

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:3001";
const READER_SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "topka_session";

export function readerSessionCookie(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === READER_SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value ? `${READER_SESSION_COOKIE}=${value}` : null;
    }
  }
  return null;
}

/**
 * The page's GETs, answered on the server. An answer the api could not give (down, timed out) is
 * left out, so the browser asks again.
 */
export async function prefetch(request: Request, paths: readonly string[]): Promise<Responses> {
  const cookie = readerSessionCookie(request.headers.get("cookie") ?? "");
  const out: Responses = {};
  const headers: Record<string, string> = { accept: "application/json", "x-topka-ssr": "1", "user-agent": request.headers.get("user-agent") ?? "" };
  if (cookie) headers.cookie = cookie;
  // The api trusts forwarded-for from loopback only: the reader's own address, for its rate limits.
  for (const name of ["accept-language", "x-forwarded-for"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  await Promise.all(paths.map(async (path) => {
    try {
      const res = await fetch(`${API_BASE}${path}`, { headers, signal: AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]) });
      if (res.status >= 500) return;
      let body: unknown = null;
      try {
        body = res.status === 204 ? null : await res.json();
      } catch {
        body = null;
      }
      out[path] = { status: res.status, body };
    } catch {
      // left out: the browser fetches it
    }
  }));
  return out;
}

/** A reader page's loader: its GETs answered on the server, handed to the page (components/shell/ReaderData). */
export function readerLoader(paths: (args: { params: Record<string, string | undefined> }) => readonly string[]) {
  return async ({ request, params }: { request: Request; params: Record<string, string | undefined> }) => ({ prefetched: await prefetch(request, paths({ params })) });
}
