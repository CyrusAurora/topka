# Threat model

One page, kept current: what an attacker can reach, what they get if they do, and which parts of the
system are trusted. It exists so a reviewer can tell whether a report is in scope without reading the
whole codebase, and so `SECURITY.md` has something concrete behind its list.

## Trust boundaries

There are five distinct parties. Every security decision follows from which side of a boundary a
request comes from.

| Party | What they can do | What they must never reach |
| --- | --- | --- |
| Anonymous visitor | Read public pages, `/api/v1`, feeds, `llms.txt`, sitemaps | Any reader's issue, any project, admin routes, stored keys |
| Registered reader | Their own projects, their own issues, their own model keys | Another reader's data, the instance's admin settings |
| Admin | Sources, budgets, prompts, other readers' metadata, ingest tokens | Readers' stored model keys in plaintext |
| Source publisher | Serve content the fetchers read | Make the server fetch an arbitrary URL, or read anything beyond the page |
| Model provider | Answer requests the worker sends | Receive anything the operator did not choose to send |

The instance operator sits outside the model: they run the machine and can read the database. The
project does not pretend to protect data from whoever holds the disk — it protects data *within* the
application, between its users.

## Assets, in order of what would hurt most

1. **Readers' model API keys (BYOK).** Stored encrypted (`KEY_ENCRYPTION_SECRET`), never returned by
   any endpoint, never logged. A leak means someone else spends the reader's money at a provider.
2. **The operator's provider budget.** Paid calls go through the receipt ledger and budget breakers;
   a bypass means unbounded spend on the operator's account.
3. **Reader identity and reading behaviour.** Who follows what, and what they read, is the private
   content of the product.
4. **The instance's admin surface.** An admin takeover means control of sources, prompts and spend.
5. **Availability.** The instance is single-node by design; there is no claim of surviving a
   determined flood, but ordinary abuse should not be trivial.

## Attack surfaces and the mitigations that exist

| Surface | The risk | What the code does about it |
| --- | --- | --- |
| Source fetchers (RSS, HTML lists, JSON, X, WeChat, external push) | SSRF: a source points at `127.0.0.1`, a link-local address, or a cloud metadata endpoint | URL validation refuses private and loopback targets (see `tests/url.test.ts`); the push endpoint requires `INGEST_TOKEN` |
| Detail-page and image fetchers | SSRF via a link inside fetched content; image proxy abuse | Same validation; the image proxy URL is signed with `IMG_PROXY_SIGN_SECRET` |
| Model base URLs (instance and BYOK) | SSRF to an internal service, or a redirect to one | The base URL is validated the same way as any other outbound target (`tests/user-keys.test.ts`) |
| Sessions and login | Session fixation, cookie theft, user enumeration | Server-side sessions, `HttpOnly` cookies, one generic answer for a wrong email or password |
| Admin routes | Authorization gaps between reader and admin | A single admin-auth check ahead of the admin API; tests assert a reader gets refused |
| Per-user issue API | Reading another reader's issue by guessing an id | Every query is scoped by the session's user id; a test asserts another reader's project shows nothing |
| MCP endpoint | Being reachable from a host that should not reach it | `MCP_ALLOWED_HOSTS` allowlist; the tools expose only public read paths |
| Public API v1 | Leaking a non-public item, or an expensive query | Only the publication read layer, cursor-bounded pages, explicit cache headers |
| Model output | Prompt injection from fetched content steering the summariser | Model output is only ever data — it never triggers a fetch, a write outside its own record, or a privileged action |
| Dependencies and build | A compromised package or action | Lockfile committed, actions pinned by commit SHA, `gitleaks` over files and history in CI |

## Deliberately out of scope

- Self-XSS in a reader's own browser session.
- Resource exhaustion from a deliberately oversized but legal configuration, in a deployment the
  operator controls.
- Editorial quality: a misjudged selection or a wrong summary that does not cross a security boundary.
- Anything that requires the operator's own credentials or database access — that is the operator.

## When this document is wrong

If you find a path that crosses a boundary above and is not listed, that is a security report, not a
documentation bug: use `SECURITY.md`'s private channel. When a fix lands, this page gains the row.
