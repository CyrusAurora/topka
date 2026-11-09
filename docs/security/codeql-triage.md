# CodeQL triage

What GitHub code scanning (`.github/workflows/codeql.yml`, the `security-extended` suite) reports on
this repository, and what was done about each alert. Every alert of the first full scan was read
against the code: a real weakness was fixed with a regression test that runs the attack
(`tests/codeql-hardening.test.ts`); a false positive was rewritten so the code is plainly safe when
that was cheap, and otherwise it is listed under [Open alerts](#open-alerts-and-their-dismissals)
with the reason to dismiss it.

## Result

| Scan (CodeQL CLI 2.27.4, `javascript-security-extended.qls`, the exported public tree) | Alerts |
| --- | --- |
| Before (commit `4eb2a25`) | 33 |
| After this triage | 4, all dismissible (below) |
| GitHub Actions queries (`actions-security-extended.qls`, the four workflow and action files) | 0 |

To reproduce: export the tree (`bash scripts/oss-export.sh <dir> HEAD`), then
`codeql database create db --language=javascript-typescript --build-mode=none --source-root=<dir>`
and `codeql database analyze db codeql/javascript-queries:codeql-suites/javascript-security-extended.qls --format=sarif-latest --output=out.sarif`.

## Every alert of the first scan

Line numbers are those of commit `4eb2a25`. "Fixed" means the code changed and the alert is gone;
"real" means the weakness could be reached, "hardening" that it could not but the change was cheap.

| # | Rule | Where | Verdict | Action |
| --- | --- | --- | --- | --- |
| 1 | `js/xss-through-dom` | `apps/web/app/routes/feedback.tsx:213` | False positive: the `<img src>` is `URL.createObjectURL(file)`, always a `blob:` URL, set as an attribute by React | Dismiss (below) |
| 2 | `js/missing-rate-limiting` | `apps/api/src/routes/accounts.ts:133` (`POST /api/auth/login`) | Hardening: already limited (10/min per address) by a hand-written window CodeQL cannot see | Fixed: `@fastify/rate-limit` ceiling `LIMITS.secret` on the route |
| 3 | `js/missing-rate-limiting` | `apps/api/src/routes/accounts.ts:179` (`POST /api/auth/delete-account`) | **Real**: a session cookie allowed unlimited password guesses (argon2 each) | Fixed: per-address ceiling and 10 attempts/min per account; test |
| 4 | `js/missing-rate-limiting` | `apps/api/src/routes/admin-auth.ts:84` (`GET /api/auth/login`) | Hardening: a redirect, no secret | Fixed: `LIMITS.signIn` |
| 5 | `js/missing-rate-limiting` | `apps/api/src/routes/admin-auth.ts:89` (`GET /api/auth/options`) | Hardening: no secret | Fixed: `LIMITS.signIn` |
| 6 | `js/missing-rate-limiting` | `apps/api/src/routes/admin-auth.ts:91` (`POST /api/auth/password`) | Hardening: already limited (10 per address, 50 overall per 15 min) | Fixed: `LIMITS.secret` in front of that; test |
| 7 | `js/missing-rate-limiting` | `apps/api/src/routes/admin-auth.ts:107` (`GET /api/auth/feishu`) | Hardening | Fixed: `LIMITS.signIn` |
| 8 | `js/missing-rate-limiting` | `apps/api/src/routes/admin-auth.ts:116` (`GET /api/auth/callback`) | Hardening: the OAuth state check makes guessing pointless | Fixed: `LIMITS.secret` |
| 9 | `js/missing-rate-limiting` | `apps/api/src/routes/admin.ts:75` (admin feedback screenshot) | Hardening: behind an admin session | Fixed: `LIMITS.file` |
| 10 | `js/missing-rate-limiting` | `apps/api/src/routes/ingest.ts:36` (`POST /api/ingest/items`) | **Real**: the 10/min window counted only authorized pushes, so wrong tokens could be tried without limit | Fixed: `LIMITS.secret` runs before the token check; test |
| 11 | `js/missing-rate-limiting` | `apps/api/src/routes/media.ts:8` (`GET /api/img-proxy`) | Hardening: unsigned requests never fetch upstream | Fixed: `LIMITS.image` (900/min: a page shows many images) |
| 12 | `js/missing-rate-limiting` | `apps/api/src/routes/static.ts:167` (`GET /contact/:file`) | Hardening: a disk read per request | Fixed: `LIMITS.file` (also on the leaderboard logo routes); test |
| 13 | `js/path-injection` | `apps/api/src/routes/static.ts:33` | False positive: the routes accept only `[\w.-]+\.(png\|…)` / `[a-z0-9-]+\.(svg\|png)`, no separator | Fixed anyway: `within(dir, name)` resolves and refuses anything outside `dir`; test |
| 14 | `js/path-injection` | `apps/api/src/routes/static.ts:36` | As 13 | As 13 |
| 15 | `js/path-injection` | `apps/api/src/routes/static.ts:173` | As 13 | As 13 |
| 16 | `js/insufficient-password-hash` | `packages/backend/src/admin/auth.ts:147` | False positive: `ADMIN_PASSWORD` is compared, never stored; HMAC only made the two sides equal length for `timingSafeEqual` | Fixed anyway: scrypt with a per-process random salt; test |
| 17 | `js/insufficient-password-hash` | `packages/backend/src/admin/auth.ts:148` | As 16 | As 16 |
| 18 | `js/insecure-randomness` | `packages/backend/src/accounts/password.ts:21` (from `login.ts:22`) | False positive in effect: `Math.random()` named the timing-only dummy hash for unknown addresses, whose result is ignored | Fixed: `randomBytes(16)` |
| 19 | `js/clear-text-logging` | `scripts/demo.ts:160` | Intended: the local demo seeder prints the demo password once to the operator's terminal | Dismiss as won't fix (below) |
| 20 | `js/clear-text-logging` | `scripts/init-env.ts:22` | Intended: `init-env` prints the admin password it generated, once | Dismiss as won't fix (below) |
| 21 | `js/bad-tag-filter` | `packages/backend/src/sources/json-list.ts:98` | Not a sanitizer (it finds JSON in a third-party page), but a bug: `</script >` ended no block | Fixed: `<\/script[^>]*>`; test |
| 22 | `js/incomplete-sanitization` | `packages/backend/src/sources/json-list.ts:73` | **Real bug**, admin-only input: a `windowVar` was used as a regex with only `$` escaped, so `.` matched anything and `(` threw | Fixed: every metacharacter escaped; test |
| 23 | `js/incomplete-sanitization` | `packages/contracts/src/http-policy.ts:80` | False positive: a redirect target from the static table, one `*` each | Fixed anyway: `replaceAll`; test |
| 24 | `js/double-escaping` | `packages/backend/src/editorial/writing.ts:40` | **Real bug**, no XSS (the output is plain text for the model): `&amp;` was decoded first, so `&amp;lt;` became `<` | Fixed: `&amp;` decoded last; test |
| 25 | `js/double-escaping` | `packages/backend/src/lib/text.ts:13` | As 24 (`stripTags`, used for titles and excerpts, which React renders as text) | As 24 |
| 26 | `js/incomplete-multi-character-sanitization` | `packages/backend/src/publication/detail.ts:31` | Low, no XSS (outline text is rendered as text): one pass left `<script` from nested fragments | Fixed: strip until stable, then drop stray brackets; test |
| 27 | `js/incomplete-url-substring-sanitization` | `apps/web/tests/today-view.test.ts:59` | False positive: `Array.prototype.includes` in a test assertion | Fixed: `Set.has` |
| 28 | `js/incomplete-url-substring-sanitization` | `apps/web/tests/today-view.test.ts:59` | As 27 | As 27 |
| 29 | `js/polynomial-redos` | `apps/api/src/routes/ingest.ts:15` | **Real pattern**, small reach: `/^Bearer\s+(.+)$/` is quadratic on whitespace, but the slow case needs a newline Node refuses in a header, and headers stop at 16 KB (~130 ms) | Fixed: `bearerToken()` splits by hand, linear; test |
| 30 | `js/file-access-to-http` | `packages/backend/src/providers/llm.ts:406` | Intended: the repository's own prompt templates (`industry/prompts/*.md`) are the model request | Dismiss as won't fix (below) |
| 31 | `js/insecure-temporary-file` | `packages/backend/src/providers/opencode-cli.ts:118` | **Real** on a shared host: the default CLI home was a predictable `/tmp/topka-opencode` another user could create first | Fixed: default `DATA_DIR/opencode`, mode 0700, config file 0600 |
| 32 | `js/file-system-race` | `apps/api/src/routes/static.ts:36` | Low: `stat` then `readFile` could cache one file's bytes under another's mtime | Fixed: one open handle for both |
| 33 | `js/file-system-race` | `scripts/init-env.ts:20` | Low: `existsSync` then write could overwrite an `.env` created in between | Fixed: `writeFileSync(…, { flag: "wx" })` |

### The rate limiter

`@fastify/rate-limit` is registered with `global: false` (`apps/api/src/http/rate-limit.ts`): only a
route that names a ceiling (`{ config: { rateLimit: LIMITS.x } }`) has one. That matters because
the web server's SSR reads all reach the api from `127.0.0.1`; a global per-address limit would turn
into one shared limit for every visitor. The routes' own finer windows (per account, the overall
admin sign-in cap) still apply on top. A refused request is `429 application/problem+json` with
`code: "rate_limited"` and `Retry-After`. Like every per-address limit here it is only as good as the
address: behind a reverse proxy set `TRUST_PROXY=true` on the web server (see
`docs/configuration.md`).

## Open alerts and their dismissals

After this triage the scan reports four alerts, none a vulnerability. On the day the public
repository first runs code scanning, dismiss them with the reasons in
[`codeql-dismissals.json`](codeql-dismissals.json) (the alert numbers are only known then, so the
loop matches each open alert by rule and file):

```bash
REPO=CyrusAurora/topka
gh api "repos/$REPO/code-scanning/alerts?state=open&per_page=100" --paginate \
  --jq '.[] | [.number, .rule.id, .most_recent_instance.location.path] | @tsv' |
while IFS=$'\t' read -r n rule path; do
  d=$(jq -c --arg r "$rule" --arg p "$path" '.[] | select(.rule == $r and .path == $p)' docs/security/codeql-dismissals.json)
  if [ -z "$d" ]; then echo "NOT TRIAGED: #$n $rule $path"; continue; fi
  gh api -X PATCH "repos/$REPO/code-scanning/alerts/$n" -f state=dismissed \
    -f dismissed_reason="$(jq -r .reason <<<"$d")" -f dismissed_comment="$(jq -r .comment <<<"$d")" > /dev/null
  echo "dismissed #$n $rule $path"
done
```

The API's `dismissed_reason` values are `false positive`, `won't fix` and `used in tests`. Any line
printed as `NOT TRIAGED` is a new alert: read it against the code like the ones above and fix it, or
add it here with its reason, before dismissing anything else.

| Rule | File | Reason | Why |
| --- | --- | --- | --- |
| `js/xss-through-dom` | `apps/web/app/routes/feedback.tsx` | false positive | The preview `<img src>` is `URL.createObjectURL(file)` for a picked PNG, JPEG or WebP: always a `blob:` URL, set as an attribute, never parsed as HTML; a `blob:` URL in `<img>` cannot run script. |
| `js/clear-text-logging` | `scripts/init-env.ts` | won't fix | The setup command prints the admin password it just generated, once, to the operator's own terminal; it is also in the 0600 `.env`. Not a server log. |
| `js/clear-text-logging` | `scripts/demo.ts` | won't fix | The local demo seeder prints the demo account's password (generated, or the operator's own `DEMO_PASSWORD`) once to the terminal that ran it. |
| `js/file-access-to-http` | `packages/backend/src/providers/llm.ts` | won't fix | The prompt templates shipped in `industry/prompts/` are the body of the model request by design; no user file or secret is read on this path. |
