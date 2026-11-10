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
| Sessions and login | Session fixation, cookie theft, user enumeration, password guessing (one client fast, or many clients against one account) | Server-side sessions, `HttpOnly` cookies, one generic answer for a wrong email or password (a disabled account is named only after the right password). Guessing: a per-client limit (10 a minute) and a per-address lockout stored in the database: 5 attempts per 15 minutes from any number of clients, then `429` with `Retry-After` for 1 minute, doubling per lock up to an hour, cleared by a successful sign-in. Each attempt is counted before the password is checked (so parallel guesses cannot slip past), and an address without an account is locked the same way, so a lock reveals nothing (`tests/login-lockout.test.ts`). The trade-off: anyone who knows an address can keep it locked for up to an hour at a time. The admin password sign-in has its own per-client and instance-wide caps (10 and 50 per 15 minutes) |
| Admin routes | Authorization gaps between reader and admin | A single admin-auth check ahead of the admin API; tests assert a reader gets refused |
| Per-user issue API | Reading another reader's issue by guessing an id | Every query is scoped by the session's user id; a test asserts another reader's project shows nothing |
| MCP endpoint | Being reachable from a host that should not reach it | `MCP_ALLOWED_HOSTS` allowlist; the tools expose only public read paths |
| Public API v1 | Leaking a non-public item, or an expensive query | Only the publication read layer, cursor-bounded pages, explicit cache headers |
| Model input | Prompt injection: an article, an author, a source name or a chat message that tries to close a prompt fence (`</material>`, `</input>`, `<|im_start|>`), forge a section label (`【已核验身份上下文】`, `【用户这次说】`), or hide text in zero-width or bidi characters | Outside text passes through `lib/untrusted.ts` before it enters a prompt: fence tags and section brackets are neutralised, invisible characters removed, names kept to one line. Outside text only goes into user messages, never the system message. No request offers the model a tool, and no secret is ever part of a prompt. The samples in `tests/fixtures/prompt-injection.json` run against a model that obeys them (`tests/prompt-injection.test.ts`, and the card case in `tests/card-copy.test.ts`) |
| Model output | A model, steered or not, returning something harmful | Model output is only ever data. Every step validates it against its schema, so a score outside 0–100 or an unknown field is refused. Tool calls in a reply are ignored, and links in it are never fetched. Output never triggers a fetch, a write outside its own record, or a privileged action. The chat assistant can only propose a card, only for the reader's own projects and existing sources, and nothing changes until the reader confirms. Residual risk: an injection can still bias a summary, a translation or a score within its range; the original is always linked, and that falls under editorial quality below |
| Stored source content | A bug or a careless script rewrites what a source said (title, body, URL) in place, so an issue or a summary can no longer be checked against the original | The database refuses it (migration `0059_article_provenance.sql`): an article's url, identity and source never change, its content changes only with revision + 1 and a matching `article_revisions` row in the same transaction, and history rows are never updated or deleted on their own (`tests/article-provenance.test.ts`). The table owner can still disable the triggers; that is the operator, out of scope below |
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
