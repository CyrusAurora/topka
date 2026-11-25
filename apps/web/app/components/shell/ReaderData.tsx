import type { ReactNode } from "react";
import { useLoaderData } from "react-router";
import { PrefetchContext, type Responses } from "../../lib/reader-data";

/** Hands a reader route's server answers (lib/reader.server.ts readerLoader) to the page below. */
export function ReaderData({ children }: { children: ReactNode }) {
  const data = useLoaderData() as { prefetched?: Responses } | null | undefined;
  return <PrefetchContext.Provider value={data?.prefetched ?? null}>{children}</PrefetchContext.Provider>;
}

/** Reader pages are per reader: never cached on the way. */
export function noStore() {
  return { "Cache-Control": "no-store" };
}
