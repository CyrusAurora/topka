# Security Policy

## Supported versions

- The `main` branch (and the latest tagged release) receives security fixes.
- Older releases are fixed on a best-effort basis; upgrades are straightforward (append-only
  migrations), so we recommend running a recent version.

## Supported components

The published, supported deliverable is the **web version for self-hosting** (docker compose
stack: `apps/api`, `apps/worker`, `apps/web`, `packages/backend`, plus the deployment files).
Private, single-user client components are **not** part of the published code.

## Reporting a vulnerability

**Please do not report security issues in public issues.** Use GitHub's private vulnerability
reporting: open the repository's **Security** tab → "Report a vulnerability"
(<https://github.com/CyrusAurora/topka/security/advisories/new>).

If that form is unavailable to you, open a public issue titled "Security contact request" that
says only which component is affected — no details, secrets, tokens or exploit steps. The
maintainer then opens a draft security advisory, adds you to it, and the report continues there
in private.

Please include:

- The affected component and, if known, file path or endpoint (e.g. `apps/api/src/...`,
  `/api/v1/...`, MCP endpoint, admin routes).
- The role/implicit trust you exploit (unauthenticated visitor, registered user, admin).
- A minimal reproduction (steps, or a small script/patch), and the impact you believe it enables.
- Whether the issue needs a specific configuration (e.g. `MODEL_CALLS_ENABLED` on, reverse
  proxy present, `KEY_ENCRYPTION_SECRET` set).

## Response targets

- **Acknowledgement** of a private report: within **7 days**.
- Triage feedback (whether it is in scope, plan) as soon as possible after triage.
- Fixes for confirmed issues land in a patch release, announced through a GitHub security
  advisory; reporters who wish to be credited are named there, only after the fix is released.
- There is one maintainer (see `MAINTAINERS.md`): these are targets kept on a best-effort basis,
  not an SLA.

## In-scope areas

- **BYOK key storage** — per-user model keys (`/api/me/keys`, `KEY_ENCRYPTION_SECRET`,
  `packages/backend/src/accounts/user-keys.ts`), key access control, and anything that could
  expose stored keys or intercept user model traffic.
- **Auth and sessions** — invite-based registration, admin login, session handling, cookie
  flags, authorization gaps between users.
- **SSRF in fetchers** — source fetchers, detail-page fetchers, image proxy, embedding/LLM base
  URLs, Jina fallback, push endpoints (`/api/ingest/items`).
- **MCP and public API** — host allowlisting (`MCP_ALLOWED_HOSTS`), tool exposure, the
  anonymous-public-api boundary, admin-only surfaces leaking to public routes.
- **Receipts/budgets bypass** — any way to spend a provider's money without going through the
  receipt ledger or the budget circuit breakers.

Out of scope: self-XSS within a single account's own browser session, resource exhaustion caused
by deliberately oversized legal configuration, and pure editorial-quality issues (misjudged
selection, wrong summaries) that do not cross a security boundary.
