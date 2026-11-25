#!/bin/bash
# Secret scan for CI and local pre-push: checks the staged + unstaged diff of this repo for
# leaked values. Prints only key NAMES (or pattern labels) on a hit, never the values;
# exits non-zero on any hit.
#
# Two halves:
#  1. Known .env value shapes: optional arguments are env files; each value ≥12 chars is
#     looked for verbatim in the diff. No files given (CI): this half is skipped.
#  2. Common token patterns: always run.
#
# Usage:
#   bash scripts/secret-scan.sh                     # CI: pattern half only
#   bash scripts/secret-scan.sh /path/to/.env ...   # server: known .env values + patterns
cd "$(git rev-parse --show-toplevel)"
tmp=$(mktemp); git add -N . 2>/dev/null; git diff HEAD > "$tmp"; git diff --cached >> "$tmp"
hits=0
for f in "$@"; do
  [ -f "$f" ] || continue
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    v="${v%\"}"; v="${v#\"}"
    [ "${#v}" -ge 12 ] || continue
    if grep -qF -- "$v" "$tmp"; then echo "HIT: $k"; hits=1; fi
  done < "$f"
done
if grep -qE "(sk-[A-Za-z0-9]{20,}|AKID[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY)" "$tmp"; then echo "HIT: token pattern"; hits=1; fi
rm -f "$tmp"
if [ "$hits" -eq 0 ]; then echo "secret scan clean"; exit 0; else exit 1; fi
