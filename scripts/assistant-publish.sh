#!/usr/bin/env bash
# Publishes a CI package (dist/ from scripts/assistant-package.sh) to GitHub Releases.
#  - tag vX.Y.Z  -> release "Assistant vX.Y.Z" (Stable; the newest is GitHub's Latest)
#  - push to main -> the rolling prerelease "nightly", replaced each time
# Each release carries the zip, its .sha256, and manifest.json, which the updater reads.
#   usage: scripts/assistant-publish.sh <dir with the three files>   (GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA)
set -euo pipefail
dir=${1:-dist}
repo=${GITHUB_REPOSITORY:?}
sha=${GITHUB_SHA:?}
manifest="$dir/manifest.json"
read_manifest() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(eval("m."+process.argv[2]))' "$manifest" "$1"; }
channel=$(read_manifest channel)
label=$(read_manifest label)
zip="$dir/$(read_manifest asset.name)"
[ -f "$zip" ] && [ -f "$zip.sha256" ] || { echo "missing $zip or its .sha256" >&2; exit 1; }
# The zip must be what the manifest says.
[ "$(sha256sum "$zip" | cut -d' ' -f1)" = "$(read_manifest asset.sha256)" ] || { echo "checksum mismatch" >&2; exit 1; }
notes=$(mktemp)
{
  echo "Assistant $label ($channel), built from ${sha:0:8} on $(read_manifest date | cut -c1-10)."
  echo
  echo "Install or switch from Settings › Updates; first install: docs/install.md."
  echo
  read_manifest notes
} > "$notes"
files=("$zip" "$zip.sha256" "$manifest")
case "$channel" in
  stable)
    tag="v$(read_manifest version)"
    [ "${GITHUB_REF:-}" = "refs/tags/$tag" ] || { echo "stable packages publish only from tag $tag" >&2; exit 1; }
    if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
      gh release upload "$tag" "${files[@]}" --clobber --repo "$repo"
    else
      gh release create "$tag" "${files[@]}" --repo "$repo" --title "Assistant $tag" \
        --notes-file "$notes" --verify-tag --latest
    fi
    ;;
  nightly)
    gh release delete nightly --repo "$repo" --yes --cleanup-tag >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6; do
      gh api "repos/$repo/git/refs/tags/nightly" >/dev/null 2>&1 || break
      sleep 2
    done
    gh release create nightly "${files[@]}" --repo "$repo" --target "$sha" --prerelease \
      --latest=false --title "Nightly (${sha:0:8})" --notes-file "$notes"
    ;;
  *) echo "a $channel package isn't published" >&2; exit 1 ;;
esac
echo "published $label"
