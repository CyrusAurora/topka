#!/usr/bin/env bash
# The pre-publication gate, in one go (CI runs it in the check job; run it locally too): export the
# ref, scan it (gitleaks + identity patterns), prove the exported tree installs, typechecks, builds
# and passes the web tests on its own, then run this repo's secret scan and the private overlay's
# typecheck and tests. Never pushes anything.
#   DATABASE_URL=postgres://…/<name>_test scripts/oss-check.sh [ref=HEAD]
# Env: OSS_DENYLIST (exact strings to look for, kept outside the repo), OSS_DEST (default a temp dir).
set -uo pipefail
ref=${1:-HEAD}
root=$(git rev-parse --show-toplevel)
cd "$root"
# The export is a full install (~360 MB): remove it afterwards unless the caller asked to keep it.
if [ -n "${OSS_DEST:-}" ]; then dest=$OSS_DEST; else dest=$(mktemp -d)/topka-export; trap 'rm -rf "${dest%/topka-export}"' EXIT; fi
fail=0
step() { printf '\n== %s\n' "$1"; }
result() { if [ "$1" -eq 0 ]; then echo "ok: $2"; else echo "FAIL: $2"; fail=1; fi; }

step "export + scan ($ref → $dest)"
OSS_FORCE=1 bash scripts/oss-export.sh "$dest" "$ref"; result $? "oss-export + oss-scan"
# The public repository's CI runs the exported copy of the scanner on its own tree; it must pass too
# (the export renames identifiers, and the scanner is one of the renamed files).
( cd "$dest" && bash scripts/oss-scan.sh . >/dev/null 2>&1 ); result $? "exported oss-scan on the exported tree"

step "exported tree stands alone"
( cd "$dest" && npm ci --no-audit --no-fund --prefer-offline >/dev/null 2>&1 ); result $? "npm ci (export)"
( cd "$dest" && npm run -s typecheck >/dev/null 2>&1 ); result $? "typecheck (export)"
( cd "$dest" && npm run -s build -w @topka/web >/dev/null 2>&1 ); result $? "web build (export)"
( cd "$dest" && node --test apps/web/tests/*.test.ts >/dev/null 2>&1 ); result $? "web tests (export)"

step "secret scan of this repo's pending diff"
bash scripts/secret-scan.sh; result $? "secret-scan"

step "private overlay"
if [ -d private ]; then
  npm --prefix private run -s typecheck >/dev/null 2>&1; result $? "private typecheck"
  db=$(node -e 'try{console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))}catch{console.log("")}')
  if [[ "$db" =~ _(test|ci)$ ]]; then
    # An empty database fails every test with "relation does not exist": say what is missing instead.
    if node -e 'import("postgres").then(async ({default:q})=>{const s=q(process.env.DATABASE_URL,{onnotice(){}});const [r]=await s`SELECT to_regclass($$public.sources$$) IS NOT NULL AS ok`;await s.end();process.exit(r.ok?0:1)})' >/dev/null 2>&1; then
      npm --prefix private test >/dev/null 2>&1; result $? "private tests (db $db)"
    else
      echo "FAIL: db $db has no schema yet: run node scripts/migrate.ts on it first"; fail=1
    fi
  else
    echo "FAIL: private tests need DATABASE_URL on a throwaway database (name ending _test or _ci)"; fail=1
  fi
else
  echo "skip: no private overlay"
fi

echo
[ "$fail" -eq 0 ] && echo "OSS CHECK PASSED" || echo "OSS CHECK FAILED"
exit $fail
