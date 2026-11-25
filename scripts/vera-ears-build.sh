#!/bin/sh
# Build hex.exe with the Vera Ears subcommand on Windows from Git Bash.
#   scripts/vera-ears-build.sh          release build: target/release/hex.exe
#   scripts/vera-ears-build.sh --dev    fast iteration: target/ears-dev/hex.exe
# Needs the Vulkan SDK (VULKAN_SDK, default D:\dev\tools\VulkanSDK, installed
# copy-only: `vulkan_sdk.exe --root D:\dev\tools\VulkanSDK --accept-licenses
# --default-answer --confirm-command install copy_only=1`) and Visual Studio
# 2022's bundled CMake and Ninja, found automatically when not on PATH.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
profile=release
[ "${1:-}" = "--dev" ] && profile=ears-dev
: "${VULKAN_SDK:=D:/dev/tools/VulkanSDK}"
export VULKAN_SDK
PATH="$(cygpath -u "$VULKAN_SDK")/Bin:$PATH"
if ! command -v cmake >/dev/null 2>&1; then
  for vs in "/c/Program Files/Microsoft Visual Studio/2022/Community" \
            "/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools" \
            "/c/Program Files/Microsoft Visual Studio/2022/Professional" \
            "/c/Program Files/Microsoft Visual Studio/2022/Enterprise"; do
    bin="$vs/Common7/IDE/CommonExtensions/Microsoft/CMake"
    if [ -x "$bin/CMake/bin/cmake.exe" ]; then
      PATH="$bin/CMake/bin:$bin/Ninja:$PATH"
      break
    fi
  done
fi
export PATH
cd "$root"
cargo build --locked --profile "$profile" --bin hex
echo "built $root/target/$profile/hex.exe"
