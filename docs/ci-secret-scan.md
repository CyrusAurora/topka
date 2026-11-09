# Secret scan

Guards against real model keys and other credentials landing in the repository. The scanner is
`scripts/secret-scan.sh` and has two halves:

- **Token patterns** — always scans: `sk-` (OpenAI-style keys), `AKID…` (cloud SecretId),
  `ghp_` (GitHub PAT), and PEM `-----BEGIN … PRIVATE KEY` blocks.
- **Known `.env` values** (local only) — pass one or more `.env` files as arguments; each value
  of ≥ 12 characters is searched for verbatim in the diff (outputs `HIT: <VAR_NAME>`, never the
  value).

On any hit it exits non-zero. Scope is the diff of staged + unstaged changes against `HEAD`, so
running it before committing is the most useful moment. Output only ever names the hit, never
echoes the secret.

## CI

The `check` job of `.github/workflows/check.yml` runs the publication gate, `scripts/oss-check.sh`:
it exports the tree (`scripts/oss-export.sh`, a fresh single-commit history), scans it
(`scripts/oss-scan.sh`: gitleaks v8.30.1 over files and history, forbidden file types, and
identity patterns with `git grep -P`, so the scan needs nothing beyond git and gitleaks and fails
rather than passes when a search cannot run), proves the exported tree installs, typechecks, builds
and passes the web tests on its own, and runs the pattern half of `scripts/secret-scan.sh`. The
`docker` job brings the exported tree up with `docker compose`, the way the README quickstart does.

An optional deny list of exact strings (`OSS_DENYLIST=/path/outside/repo`, one per line) catches
values the generic patterns cannot know; keep that file outside the repository.

## Local pre-push hook

Scan your own environment file before pushing (the known-values half makes your real keys
testable against the diff):

```bash
bash scripts/secret-scan.sh /path/to/your/.env
```

To run it on every push:

```bash
git config --local core.hooksPath .githooks
mkdir -p .githooks
cat > .githooks/pre-push <<'EOF'
#!/bin/bash
# Usage: bash scripts/secret-scan.sh /path/to/your/.env
bash scripts/secret-scan.sh /path/to/your/.env || exit 1
EOF
```

`.githooks/` is intentionally not tracked: the absolute path in it is yours.

## Notes

- Adding your `.env` argument is what makes the local half meaningful; without arguments the
  scanner checks only token patterns.
- `.env*` files must never be committed (`git check-ignore .env` should print `.env`);
  `.env.example` is the only tracked example and holds placeholders.
