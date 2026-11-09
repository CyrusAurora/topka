#!/usr/bin/env bash
# Exports the publishable tree of a git ref into a fresh directory with a brand-new, single-commit
# history (no past commits travel along), then runs scripts/oss-scan.sh on it. Never pushes anything.
#   scripts/oss-export.sh <dest-dir> [ref=HEAD]
# Env: OSS_AUTHOR (default "The Topka Authors <authors@noreply.invalid>"), OSS_MESSAGE,
#      OSS_DENYLIST (passed through to oss-scan.sh), OSS_FORCE=1 to replace an existing dest.
set -euo pipefail
dest=${1:?usage: oss-export.sh <dest-dir> [ref]}
ref=${2:-HEAD}
root=$(git rev-parse --show-toplevel)
cd "$root"
author=${OSS_AUTHOR:-"The Topka Authors <authors@noreply.invalid>"}
msg=${OSS_MESSAGE:-"Initial public release"}

if [ -e "$dest" ]; then
  [ "${OSS_FORCE:-}" = 1 ] || { echo "refusing: $dest exists (set OSS_FORCE=1 to replace)" >&2; exit 1; }
  rm -rf "$dest"
fi
mkdir -p "$dest"

# The exclude list is read from the ref itself, so an export always matches that ref's rules.
excl=()
while IFS= read -r p; do
  p=${p%%#*}; p=$(printf '%s' "$p" | xargs); [ -n "$p" ] && excl+=(":(exclude)$p")
done < <(git show "$ref:scripts/oss-export.exclude")

git archive --format=tar "$ref" -- . "${excl[@]}" | tar -x -C "$dest"
# The public tree carries the Topka name only. The transform is maintainer tooling (read from the
# working tree, not exported); the public tree has nothing left to rename.
if [ -f "$root/scripts/oss-transform.sh" ]; then bash "$root/scripts/oss-transform.sh" "$dest"; fi

cd "$dest"
git init -q -b main
git add -A
name=${author% <*}; email=${author##*<}; email=${email%>}
GIT_AUTHOR_DATE="$(git -C "$root" show -s --format=%cI "$ref")" GIT_COMMITTER_DATE="$(git -C "$root" show -s --format=%cI "$ref")" \
  git -c user.name="$name" -c user.email="$email" -c commit.gpgsign=false commit -q -m "$msg"
echo "exported $(git -C "$root" rev-parse --short "$ref") -> $dest ($(git ls-files | wc -l) files, 1 commit)"

bash "$root/scripts/oss-scan.sh" "$dest"
