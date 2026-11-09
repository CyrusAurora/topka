// Per-address request ceilings for the routes that check a secret or read a file: sign-in, the
// ingest token, the signed image proxy, the admin screenshot and the contact codes. @fastify/rate-limit
// is registered with `global: false`, so only a route that names a ceiling in its options has one
// (`{ config: { rateLimit: LIMITS.x } }`); everything else, including the SSR reads that all arrive
// from 127.0.0.1, is untouched. The routes' own finer limits (per account, the overall sign-in cap)
// still apply on top: this is the coarse backstop that holds before any secret is compared.
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

const minute = 60_000;

/** The ceilings, per client address. Generous for a person, too slow for a guessing script. */
export const LIMITS = {
  /** A password or token is compared: sign-in, account deletion, the ingest bearer token. */
  secret: { max: 20, timeWindow: minute },
  /** Sign-in redirects and the sign-in page's options read: no secret, but the doorway to one. */
  signIn: { max: 60, timeWindow: minute },
  /** Files read from disk per request (contact codes, the admin's feedback screenshots). */
  file: { max: 240, timeWindow: minute },
  /** The image proxy: a page shows many images, each a signed request that may fetch upstream. */
  image: { max: 900, timeWindow: minute },
} as const;

/** What a refused request carries to the error handler: the seconds until the window frees. */
export class RateLimited extends Error {
  readonly statusCode = 429;
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super("rate limited");
    this.retryAfter = retryAfter;
  }
}

export async function registerRateLimit(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: false,
    // Retry-After goes in the problem body and header written by the error handler (app.ts).
    addHeaders: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true, "x-ratelimit-reset": true, "retry-after": false },
    errorResponseBuilder: (_req, ctx) => new RateLimited(Math.max(1, Math.ceil(ctx.ttl / 1000))),
  });
}
