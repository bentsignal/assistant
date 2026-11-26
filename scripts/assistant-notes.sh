#!/usr/bin/env bash
# Writes a release's notes (markdown) to <out>: what changed since the channel's last release.
#   stable:  release-notes/assistant/v<version>.md if present, then commits since the previous v* tag
#   nightly: commits since the commit the current nightly was built from (its manifest.json)
#   usage: scripts/assistant-notes.sh <stable|nightly|dev> <out>   (GH_TOKEN and GITHUB_REPOSITORY for nightly)
set -euo pipefail
channel=$1
out=$2
head=${ASSISTANT_COMMIT:-$(git rev-parse HEAD)}
version=$(tr -d '[:space:]' < assistant/VERSION)
since=""
: > "$out"
case "$channel" in
  stable)
    written="release-notes/assistant/v$version.md"
    if [ -f "$written" ]; then cat "$written" >> "$out"; echo >> "$out"; fi
    since=$(git describe --tags --abbrev=0 --match 'v*' "$head^" 2>/dev/null || true)
    ;;
  nightly)
    if [ -n "${GITHUB_REPOSITORY:-}" ]; then
      tmp=$(mktemp -d)
      if gh release download nightly --repo "$GITHUB_REPOSITORY" --pattern manifest.json --dir "$tmp" >/dev/null 2>&1; then
        since=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit||"")' "$tmp/manifest.json")
      fi
      rm -rf "$tmp"
    fi
    ;;
esac
if [ -n "$since" ] && git merge-base --is-ancestor "$since" "$head" 2>/dev/null && [ "$(git rev-parse "$since")" != "$(git rev-parse "$head")" ]; then
  git log --no-merges --pretty='- %s (%h)' "$since..$head" | head -n 40 >> "$out"
else
  git log --no-merges -n 15 --pretty='- %s (%h)' "$head" >> "$out"
fi
