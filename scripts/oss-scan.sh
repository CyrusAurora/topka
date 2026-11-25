#!/usr/bin/env bash
# Pre-publication scan of an exported tree (see oss-export.sh). Exit 1 on any finding.
#   scripts/oss-scan.sh <dir>
# Checks: gitleaks over files and history; maintainer-only paths; forbidden file types; generic
# identity patterns (home/server paths, non-example emails, WeChat AppIDs, private IPs, personal names,
# retired and upstream brand names); and an optional
# deny list of exact strings (OSS_DENYLIST, one per line, kept OUTSIDE the repo; it holds the real
# values to look for, so findings print only the pattern number and file:line, never the value).
set -uo pipefail
dir=${1:?usage: oss-scan.sh <dir>}
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$dir"
bad=0
note() { printf '%-10s %s\n' "$1" "$2"; }

if command -v gitleaks >/dev/null; then
  if gitleaks dir --redact --no-banner -l error . >/dev/null 2>&1; then note ok "gitleaks dir"; else note FAIL "gitleaks dir found leaks (run: gitleaks dir --redact $dir)"; bad=1; fi
  if [ -d .git ]; then
    if gitleaks git --redact --no-banner -l error . >/dev/null 2>&1; then note ok "gitleaks git ($(git rev-list --count HEAD) commit)"; else note FAIL "gitleaks git found leaks"; bad=1; fi
  fi
else
  note FAIL "gitleaks not installed"; bad=1
fi

files() { if [ -d .git ]; then git ls-files -z; else find . -type f -not -path './.git/*' -print0; fi; }

for p in private ops .coderabbit.yaml .github/dependabot.yml; do
  [ -e "$p" ] && { note FAIL "maintainer-only path present: $p"; bad=1; }
done
forbidden=$(files | tr '\0' '\n' | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$|\.p12$|\.dump$|\.sqlite3?$|(^|/)\.pm2/|(^|/)logs/|project\.private\.config\.json$|config\.local\.js$' | grep -v '\.env\.example$' || true)
[ -n "$forbidden" ] && { note FAIL "forbidden files:"; printf '  %s\n' $forbidden; bad=1; } || note ok "no env/key/dump/local-config files"

# Generic patterns over the tracked files (`git grep -P`, so the scan needs nothing beyond git, and an
# unusable grep fails the scan instead of passing it). Always skipped: this script and package-lock.json.
# tests/url.test.ts and tests/user-keys.test.ts list private IPs on purpose (SSRF tests).
[ -d .git ] || { note FAIL "not a git tree (run it on the output of oss-export.sh)"; exit 1; }
scan() { # label, pcre, extra excluded globs...
  local label=$1 re=$2; shift 2
  local ex=(':(exclude)scripts/oss-scan.sh' ':(exclude)package-lock.json')
  for g in "$@"; do ex+=(":(exclude,glob)$g"); done
  local hits rc
  hits=$(git grep -n -I -P -e "$re" -- . "${ex[@]}" 2>&1); rc=$?
  if [ "$rc" -gt 1 ]; then note FAIL "$label: git grep failed: ${hits:0:200}"; bad=1
  elif [ "$rc" -eq 0 ]; then note FAIL "$label"; printf '%s\n' "$hits" | cut -c1-160 | sed 's/^/  /' | head -n 20; bad=1
  else note ok "$label"; fi
}
scan "home/server paths" '(/home/[a-z][\w-]*/|/workspace/|/Users/[A-Za-z])'
scan "emails (non-example)" '[A-Za-z0-9._%+-]+@(?!(example\.(com|org|net)|noreply\.invalid|users\.noreply\.github\.com)\b)[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[a-z]{2,}' '**/*.svg'
scan "WeChat AppID" '\bwx[0-9a-f]{16}\b'
scan "private IPv4" '\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b' tests/url.test.ts tests/user-keys.test.ts
# The maintainer's own client app and hosting stay out of the public tree, comments and migrations included.
scan "maintainer-only words" '(?i)mini-?program|小程序|cloudbase|nrRemind|mp-sync|mp-bridge|\bthe box\b'
# The project's retired working name must not reach the public tree (the public name is Topka).
# Pixels are not scanned: screenshots in docs/assets/ must be regenerated from the current build on
# demo data, never showing a retired or upstream brand or a real user's data (see CONTRIBUTING.md).
scan "retired brand name" '(?i)news[\s_-]?radar|\bNR_[A-Z]'
# The public home is github.com/CyrusAurora/topka; the once-planned org and domain were never taken,
# so a link to either would point at someone else's (or nobody's) site.
scan "unused public home" '(?i)\btopkahq\b|\btopka\.dev\b|<your-fork>'
# The referenced project's name and author: one thank-you line at the end of each README, NOTICE, and
# the MIT copyright line in LICENSE. Spelled ai[h]ot so scripts/oss-transform.sh (which renames the bare
# word in every exported file) leaves it alone: the public tree runs this same scan in its own CI.
scan "upstream name outside the credit" '(?i)ai[h]ot|khazix|卡兹克' NOTICE LICENSE README.md README.en.md
for f in README.md README.en.md; do
  n=$(grep -ciP 'ai[h]ot' "$f" || true); last=$(grep -v '^[[:space:]]*$' "$f" | tail -n 1)
  if [ "$n" -le 1 ] && { [ "$n" -eq 0 ] || printf '%s' "$last" | grep -qiP 'ai[h]ot'; }; then note ok "$f: credit is one line at the end"
  else note FAIL "$f: the credit must be a single line at the end ($n lines)"; bad=1; fi
done
[ "$(grep -c . NOTICE 2>/dev/null || echo 0)" -le 2 ] && note ok "NOTICE is minimal" || { note FAIL "NOTICE: keep it to the credit and the copyright line"; bad=1; }
# Personal names and handles: the maintainer handle appears only in the repository address and MAINTAINERS.md.
scan "personal names" '(?i)\bcyrus\b|my[h]ot|zhang[x]r|cursor\.local'
scan "maintainer handle outside the repo address" '(?i)cyrusaurora(?!(/|\.github\.io/|~)topka)' MAINTAINERS.md

# Every dependency resolves from the public npm registry: a mirror host in the lockfile is a maintainer's
# local npm config leaking into what every stranger's `npm ci` downloads from.
hosts=$(grep -oE '"resolved": "[a-z+]+://[^/"]+' package-lock.json 2>/dev/null | sed -E 's/.*"resolved": "//' | sort -u)
other=$(printf '%s\n' "$hosts" | grep -vx 'https://registry.npmjs.org' | grep . || true)
if [ -z "$hosts" ]; then note FAIL "package-lock.json: no resolved URLs found"; bad=1
elif [ -n "$other" ]; then note FAIL "package-lock.json resolves from: $(echo $other) (only https://registry.npmjs.org)"; bad=1
else note ok "lockfile resolves from registry.npmjs.org only"; fi

if [ -n "${OSS_DENYLIST:-}" ]; then
  if [ ! -f "$OSS_DENYLIST" ]; then note FAIL "OSS_DENYLIST not found"; bad=1
  else
    n=0; hitn=0
    while IFS= read -r v; do
      n=$((n+1)); [ -z "$v" ] && continue; case "$v" in \#*) continue;; esac
      where=$(files | xargs -0 grep -n -F -i -l -e "$v" 2>/dev/null | head -n 5 | tr '\n' ' ')
      [ -n "$where" ] && { note FAIL "deny-list pattern #$n in: $where"; hitn=$((hitn+1)); }
      if [ -d .git ] && git log --all -p -i -S"$v" --format=%h | grep -q .; then note FAIL "deny-list pattern #$n in git history"; hitn=$((hitn+1)); fi
    done < "$OSS_DENYLIST"
    [ "$hitn" -eq 0 ] && note ok "deny list ($n patterns)" || bad=1
  fi
else
  note skip "deny list (set OSS_DENYLIST=/path/outside/repo)"
fi

[ "$bad" -eq 0 ] && echo "OSS SCAN CLEAN" || echo "OSS SCAN FAILED"
exit $bad
