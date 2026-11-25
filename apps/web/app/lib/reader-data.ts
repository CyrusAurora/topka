// How a reader page gets its data: one convention for every page under the reader shell.
// The route's loader asks the api for the page's GETs on the server (lib/reader.server.ts) and hands
// the answers down through PrefetchContext, so the first paint is the finished page, not a loading
// line. Without them (the online demo, component tests, a reload after an action) the same GETs are
// fetched in the browser. A page reads the answers with useReaderData and turns them into its view
// with a pure function, the same one on the server and in the browser.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export interface Got {
  status: number;
  body: unknown;
}
export type Responses = Record<string, Got>;

export const PrefetchContext = createContext<Responses | null>(null);

/** What one answer means to a reader page. */
export function phaseOf(got: Got | undefined): "signed-out" | "failed" | "ready" {
  if (!got) return "failed";
  if (got.status === 401) return "signed-out";
  return got.status >= 200 && got.status < 300 ? "ready" : "failed";
}

/** The body of a good answer, or null. */
export function bodyOf<T>(got: Got | undefined): T | null {
  return got && phaseOf(got) === "ready" ? (got.body as T) : null;
}

export async function fetchAll(paths: readonly string[], doFetch: typeof fetch): Promise<Responses> {
  const out: Responses = {};
  await Promise.all(paths.map(async (path) => {
    try {
      const res = await doFetch(path);
      let body: unknown = null;
      try {
        body = res.status === 204 ? null : await res.json();
      } catch {
        body = null;
      }
      out[path] = { status: res.status, body };
    } catch {
      out[path] = { status: 0, body: null };
    }
  }));
  return out;
}

function pick(from: Responses | null, paths: readonly string[]): Responses | null {
  if (!from || !paths.every((p) => p in from)) return null;
  return Object.fromEntries(paths.map((p) => [p, from[p]!]));
}

/**
 * The answers to a page's GETs: the server's on first paint (and after each client-side navigation,
 * when the loader runs again), otherwise fetched after mount. `reload` fetches them again.
 */
export function useReaderData(paths: readonly string[], fetchImpl?: typeof fetch): { data: Responses | null; reload: () => Promise<Responses> } {
  const prefetched = useContext(PrefetchContext);
  const key = paths.join("\n");
  const [state, setState] = useState<{ source: Responses | null; key: string; data: Responses | null }>(() => ({ source: prefetched, key, data: pick(prefetched, paths) }));
  // New loader data or another set of paths (the same page, other params): start from those.
  if (state.source !== prefetched || state.key !== key) {
    setState({ source: prefetched, key, data: pick(prefetched, paths) });
  }
  const doFetch = useRef(fetchImpl ?? fetch.bind(globalThis));
  doFetch.current = fetchImpl ?? doFetch.current;
  const reload = useCallback(async () => {
    const data = await fetchAll(paths, doFetch.current);
    setState((cur) => (cur.key === key ? { ...cur, data } : cur));
    return data;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const seeded = pick(prefetched, paths) !== null;
  useEffect(() => {
    if (!seeded) void reload();
  }, [seeded, reload]);
  return { data: state.key === key ? state.data : null, reload };
}

/** One GET: its phase and body, the common case. */
export function useReaderGet<T>(path: string, fetchImpl?: typeof fetch): { phase: "loading" | "signed-out" | "failed" | "ready"; body: T | null; reload: () => Promise<Responses> } {
  const paths = useMemoPaths(path);
  const { data, reload } = useReaderData(paths, fetchImpl);
  if (!data) return { phase: "loading", body: null, reload };
  const got = data[path];
  const phase = phaseOf(got);
  return { phase, body: phase === "ready" ? (got!.body as T) : null, reload };
}

const pathLists = new Map<string, readonly string[]>();
function useMemoPaths(path: string): readonly string[] {
  let list = pathLists.get(path);
  if (!list) {
    list = [path];
    if (pathLists.size > 500) pathLists.clear();
    pathLists.set(path, list);
  }
  return list;
}

/** The server's answers for these paths, when the page has all of them; for pages that keep their own state. */
export function usePrefetched(paths: readonly string[]): Responses | null {
  return pick(useContext(PrefetchContext), paths);
}
