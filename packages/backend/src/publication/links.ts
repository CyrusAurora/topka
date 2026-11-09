import { config } from "../config.ts";

// Absolute links always use the configured address (SITE_URL), never the request Host: a CDN or proxy
// may send a different Host to the origin.
export const siteUrl = (path: string): string => `${config.siteUrl}${path}`;
export const itemUrl = (id: string): string => siteUrl(`/items/${id}`);
// The old story and daily pages are retired (they answer 301): links point where those redirects land,
// so feeds and the API never hand out a link that only bounces. The ids stay in the API's own fields.
export const storyUrl = (_publicId: string): string => siteUrl("/");
export const dailyUrl = (_date: string): string => siteUrl("/archive");
export const storyApiUrl = (publicId: string): string => siteUrl(`/api/v1/stories/${publicId}`);
