// An old item link (/items/:id, /items/:id/original) from an RSS reader or an API client: the item
// page is retired, so the link goes to the original article; an unknown or non-public item goes home.
import { redirect } from "react-router";
import type { Route } from "./+types/item-redirect";
import { apiGet } from "../lib/api.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  try {
    const item = await apiGet<{ originalUrl?: string }>(`/api/site/items/${encodeURIComponent(params.id)}`, { signal: request.signal });
    if (item.originalUrl && /^https?:\/\//.test(item.originalUrl)) throw redirect(item.originalUrl, 302);
  } catch (error) {
    if (error instanceof Response) throw error;
  }
  throw redirect("/", 302);
}

export default function ItemRedirect() {
  return null;
}
