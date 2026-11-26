#!/usr/bin/env bash
# Builds Assistant's Windows release package (docs/install.md) from Git Bash:
#
#   dist/assistant-<label>-windows-x64.zip         the whole app, unpacked into versions\<label>
#   dist/assistant-<label>-windows-x64.zip.sha256
#   dist/manifest.json                             version, label, channel, commit, date, notes, sha256
#
# The zip holds assistant.exe, Core bundled for Node (core/dist, no node_modules), a portable
# node.exe, the voice service's code with its pyproject.toml and uv.lock, and uv.exe (which
# makes the voice venv from that lock). User data (~/.assistant) is never in it.
#
#   ASSISTANT_CHANNEL=stable|nightly|dev     default dev
#   ASSISTANT_COMMIT                         default: git HEAD
#   ASSISTANT_NOTES_FILE                     release notes (markdown); default: recent commits
#   ASSISTANT_SKIP_BUILD=1                   reuse target/release/assistant.exe (local tries only)
#   ASSISTANT_PACKAGE_CACHE                  where Node and uv downloads are kept (default .cache/package)
set -euo pipefail
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

NODE_VERSION=22.23.5
UV_VERSION=0.13.7

channel=${ASSISTANT_CHANNEL:-dev}
commit=${ASSISTANT_COMMIT:-$(git rev-parse HEAD)}
version=$(tr -d '[:space:]' < assistant/VERSION)
date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
day=$(git show -s --format=%cd --date=format:%Y%m%d "$commit" 2>/dev/null || date -u +%Y%m%d)
case "$channel" in
  stable) label=$version ;;
  nightly) label="$version-nightly.$day.${commit:0:8}" ;;
  dev) label="$version-dev.$day.${commit:0:8}" ;;
  *) echo "ASSISTANT_CHANNEL must be stable, nightly or dev" >&2; exit 1 ;;
esac
name="assistant-$label-windows-x64"
cache=${ASSISTANT_PACKAGE_CACHE:-$root/.cache/package}
dist=$root/dist
stage=$dist/stage
mkdir -p "$cache" "$dist"
echo "packaging $label ($channel, ${commit:0:8})"

winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
sha256() { sha256sum "$1" | cut -d' ' -f1; }
fetch() { # url dest: downloads once into the cache
  if [ ! -f "$2" ]; then curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; fi
}

# 1. assistant.exe, stamped with what this package is.
if [ "${ASSISTANT_SKIP_BUILD:-}" != 1 ]; then
  ASSISTANT_CHANNEL=$channel ASSISTANT_COMMIT=$commit ASSISTANT_BUILD_DATE=$date \
    ASSISTANT_LABEL=$label sh scripts/assistant-build.sh
fi
exe=target/release/assistant.exe
[ -f "$exe" ] || { echo "no $exe" >&2; exit 1; }

rm -rf "$stage" && mkdir -p "$stage"
cp "$exe" "$stage/assistant.exe"
cp LICENSE "$stage/LICENSE.txt"
cp THIRD_PARTY_NOTICES.md "$stage/THIRD_PARTY_NOTICES.txt"

# 2. Core, bundled (no node_modules at runtime).
(cd assistant && pnpm install --frozen-lockfile >/dev/null)
mkdir -p "$stage/core"
node assistant/core/scripts/bundle.mjs "$stage/core/dist"
cp -r assistant/core/prompts "$stage/core/prompts"
cp assistant/core/package.json "$stage/core/package.json"

# 3. Node, checked against nodejs.org's SHASUMS256.txt.
node_zip="node-v$NODE_VERSION-win-x64.zip"
fetch "https://nodejs.org/dist/v$NODE_VERSION/$node_zip" "$cache/$node_zip"
fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$cache/node-$NODE_VERSION-SHASUMS256.txt"
want=$(grep " $node_zip\$" "$cache/node-$NODE_VERSION-SHASUMS256.txt" | cut -d' ' -f1)
[ "$(sha256 "$cache/$node_zip")" = "$want" ] || { echo "$node_zip checksum mismatch" >&2; rm -f "$cache/$node_zip"; exit 1; }
mkdir -p "$stage/node"
unzip -q -j -o "$cache/$node_zip" "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$stage/node"

# 4. uv, checked against its release's .sha256.
uv_zip=uv-x86_64-pc-windows-msvc.zip
fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$uv_zip" "$cache/uv-$UV_VERSION.zip"
fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$uv_zip.sha256" "$cache/uv-$UV_VERSION.zip.sha256"
want=$(cut -d' ' -f1 < "$cache/uv-$UV_VERSION.zip.sha256")
[ "$(sha256 "$cache/uv-$UV_VERSION.zip")" = "$want" ] || { echo "uv checksum mismatch" >&2; rm -f "$cache/uv-$UV_VERSION.zip"; exit 1; }
mkdir -p "$stage/tools"
unzip -q -j -o "$cache/uv-$UV_VERSION.zip" uv.exe -d "$stage/tools"

# 5. The voice service's code and its lock (its venv is made from the lock on the PC).
mkdir -p "$stage/voice"
cp -r assistant/voice/assistant_voice "$stage/voice/assistant_voice"
find "$stage/voice" -name __pycache__ -type d -prune -exec rm -rf {} +
cp assistant/voice/pyproject.toml assistant/voice/uv.lock assistant/voice/README.md "$stage/voice/"
voice_lock=$(sha256 assistant/voice/uv.lock)

# 6. What this package is.
cat > "$stage/assistant-package.json" <<EOF
{
  "name": "assistant",
  "version": "$version",
  "label": "$label",
  "channel": "$channel",
  "commit": "$commit",
  "date": "$date",
  "node": "$NODE_VERSION",
  "uv": "$UV_VERSION",
  "voice_lock": "$voice_lock"
}
EOF
"$stage/assistant.exe" --version | grep -q "$label" || { echo "assistant.exe isn't stamped $label" >&2; exit 1; }

# 7. The zip, with Windows' own bsdtar (Git Bash's tar can't write zips).
zip="$dist/$name.zip"
rm -f "$zip"
(cd "$stage" && "${SYSTEMROOT:-C:\\Windows}\\System32\\tar.exe" -a -cf "$(winpath "$zip")" *)
size=$(stat -c %s "$zip")
hash=$(sha256 "$zip")
echo "$hash *$name.zip" > "$zip.sha256"

# 8. The manifest the updater reads.
notes_file=${ASSISTANT_NOTES_FILE:-}
if [ -z "$notes_file" ]; then
  notes_file=$(mktemp)
  git log -n 15 --pretty='- %s (%h)' "$commit" > "$notes_file" 2>/dev/null || true
fi
node -e '
const fs = require("fs")
const [out, notes, ...rest] = process.argv.slice(1)
const [version, label, channel, commit, date, asset, size, sha256, voice_lock] = rest
fs.writeFileSync(out, JSON.stringify({
  schema: 1, name: "assistant", version, label, channel, commit, date,
  notes: fs.readFileSync(notes, "utf8").trim(),
  asset: { name: asset, size: Number(size), sha256 },
  voice_lock,
}, null, 2) + "\n")
' "$dist/manifest.json" "$notes_file" "$version" "$label" "$channel" "$commit" "$date" "$name.zip" "$size" "$hash" "$voice_lock"

echo "built $zip ($size bytes, sha256 $hash)"
echo "label=$label" > "$dist/package.env"
