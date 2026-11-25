#!/bin/sh
# Build vera.exe (the Vera desktop app, VERA.md) on Windows from Git Bash.
#   scripts/vera-app-build.sh          release build: target/release/vera.exe
#   scripts/vera-app-build.sh --dev    fast iteration: target/ears-dev/vera.exe
# Same toolchain needs as scripts/vera-ears-build.sh (Vulkan SDK, VS 2022's
# CMake and Ninja), found the same way.
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
cargo build --locked --profile "$profile" --bin vera
echo "built $root/target/$profile/vera.exe"
