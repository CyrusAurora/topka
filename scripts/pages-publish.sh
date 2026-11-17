#!/usr/bin/env bash
# Publishes the online demo's data (docs/online-demo.md): exports one reader's fixed issues
# (scripts/pages-export.ts, leak-scanned), and when they changed, or the published copy is older than
# PAGES_REFRESH_HOURS, replaces the single commit on the public repository's `pages-data` branch and
# starts its Pages workflow. Prints counts only, never content, emails or tokens.
#   PAGES_REPO=owner/name PAGES_DEMO_READER=reader@example.com bash scripts/pages-publish.sh [--dry-run]
# Needs git push access to PAGES_REPO and `gh` signed in (for the workflow run). Exit 0 published or
# nothing to do, 1 refused or failed.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=${PAGES_REPO:?set PAGES_REPO=owner/name}
REFRESH_HOURS=${PAGES_REFRESH_HOURS:-20}
DRY=${1:-}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pages-publish.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

node --env-file-if-exists=.env scripts/pages-export.ts --out "$WORK/data" ${OSS_DENYLIST:+--deny "$OSS_DENYLIST"}
node scripts/pages-check.ts "$WORK/data"

# The copy now published, if any.
if git ls-remote --exit-code --heads "https://github.com/$REPO.git" pages-data > /dev/null 2>&1; then
  git clone --quiet --depth 1 --branch pages-data "https://github.com/$REPO.git" "$WORK/current"
fi

decision=$(node -e '
  const fs = require("node:fs"), path = require("node:path");
  const [fresh, cur, hours] = process.argv.slice(1);
  const read = (d) => { const out = {}; const walk = (p, r) => { for (const n of fs.readdirSync(p)) { if (n === ".git") continue; const f = path.join(p, n); fs.statSync(f).isDirectory() ? walk(f, r + n + "/") : (out[r + n] = fs.readFileSync(f, "utf8")); } }; if (fs.existsSync(d)) walk(d, ""); return out; };
  const strip = (files) => { const c = { ...files }; if (c["meta.json"]) { const m = JSON.parse(c["meta.json"]); delete m.updatedAt; c["meta.json"] = JSON.stringify(m); } if (c["today.json"]) { const t = JSON.parse(c["today.json"]); delete t.generatedAt; c["today.json"] = JSON.stringify(t); } return JSON.stringify(Object.entries(c).sort()); };
  const a = read(fresh), b = read(cur);
  if (!Object.keys(b).length) { console.log("first"); process.exit(0); }
  if (strip(a) !== strip(b)) { console.log("changed"); process.exit(0); }
  const age = (Date.now() - Date.parse(JSON.parse(b["meta.json"]).updatedAt)) / 3600e3;
  console.log(age >= Number(hours) ? "refresh" : "same");
' "$WORK/data" "$WORK/current" "$REFRESH_HOURS")

if [ "$decision" = same ]; then
  echo "pages-publish: unchanged and fresh; nothing to publish"
  exit 0
fi
if [ "$DRY" = --dry-run ]; then
  echo "pages-publish: would publish ($decision); dry run"
  exit 0
fi

cd "$WORK/data"
git init -q -b pages-data
git add -A
git -c user.name="${PAGES_GIT_NAME:-Topka demo data}" -c user.email="${PAGES_GIT_EMAIL:-pages-data@users.noreply.github.com}" \
  commit -qm "demo data: $(node -p 'const m=require("./meta.json"); `${m.issueCount} issues, latest ${m.latestIssueDate}`')"
# One commit on a data-only branch: each publish replaces the last, so the branch never grows.
git push -q --force "https://github.com/$REPO.git" HEAD:refs/heads/pages-data
cd - > /dev/null
gh workflow run pages.yml -R "$REPO" --ref main > /dev/null
echo "pages-publish: published ($decision); Pages workflow started"
