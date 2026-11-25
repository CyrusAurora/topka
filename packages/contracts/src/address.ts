// Where this install is reached, set in one place. PORT in .env is where docker compose publishes the web
// container ("3300", "127.0.0.1:3300", "0.0.0.0:3300"); the site address follows it unless SITE_URL is set
// (a public domain, a reverse proxy) or SITE_DOMAIN names the https profile's domain.

type Env = Record<string, string | undefined>;

/** The port in a compose-style PORT value, or null when there is none. */
export function publishedPort(value: string | undefined): number | null {
  const match = /^(?:.*:)?(\d{1,5})$/.exec((value ?? "").trim());
  const port = match ? Number(match[1]) : NaN;
  return port > 0 && port < 65536 ? port : null;
}

/** The host part of a PORT value as a browser would use it; loopback and wildcard addresses read as localhost. */
function publishedHost(value: string): string {
  const at = value.lastIndexOf(":");
  const host = at > 0 ? value.slice(0, at).replace(/^\[|\]$/g, "") : "";
  if (!host || ["127.0.0.1", "0.0.0.0", "::", "::1", "localhost"].includes(host)) return "localhost";
  return host.includes(":") ? `[${host}]` : host;
}

/** SITE_URL if set, else https://SITE_DOMAIN, else http://<host>:<PORT>, else the fallback; no trailing slash. */
export function siteAddress(env: Env, fallback: string): string {
  const explicit = env.SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = env.SITE_DOMAIN?.trim();
  if (domain) return `https://${domain}`;
  const raw = env.PORT?.trim() ?? "";
  const port = publishedPort(raw);
  if (port) return port === 80 ? `http://${publishedHost(raw)}` : `http://${publishedHost(raw)}:${port}`;
  return fallback.replace(/\/+$/, "");
}
