# Developing Assistant on Winserve

All Assistant development happens on **Winserve** (`S:\dev\assistant`). GamerBox,
Shawn's main PC, only runs released builds (installed with
[`docs/install.md`](install.md)); never build, test, or install anything there
from a dev session.

Winserve: Windows 11 Home x64, 16 threads, NVIDIA GeForce RTX 3070 (8 GB, driver
621.01, CUDA works, Vulkan 1.4.357). `C:` is nearly full (about 10 GB free), so
everything big lives on `S:`.

## What's installed and where

| Tool | Version | Where |
| --- | --- | --- |
| Rust (stable, MSVC) | 1.99.1 | rustup, `~\.cargo` (no `rust-toolchain.toml`: the latest stable) |
| MSVC, CMake, Ninja | VS Build Tools 2022 17.14 | `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools` (CMake and Ninja under `Common7\IDE\CommonExtensions\Microsoft\CMake`; `scripts/assistant-build.sh` finds them) |
| Vulkan SDK | 1.4.363.1 | `S:\dev\tools\VulkanSDK` (user `VULKAN_SDK` points there) |
| Node | 22.23.5 (what installs ship) | `S:\dev\tools\node22`; the system Node is 24 |
| pnpm | 10.34 (the workspace pins 10.12.3 and pnpm switches to it) | system |
| uv | 0.13.10 | `~\.local\bin\uv.exe`; user `UV_CACHE_DIR=S:\dev\cache\uv` |
| Python 3.12 | uv-managed | for the voice venv |
| 7-Zip | 25.01 (portable) | `S:\dev\tools\7zip-msi\Files\7-Zip\7z.exe` (only for unpacking the Vulkan SDK) |

`~\.assistant` is a **junction to `S:\assistant-home`**, so the voice venv (4.8
GB), the Qwen3-TTS model (4.3 GB), and the speech model live on `S:` while every
path still reads `~/.assistant`. (On GamerBox it's a plain folder.)

The Vulkan SDK's installer won't run without admin rights from a command line, so
it's unpacked instead: `scripts/assistant-vulkan-sdk.py` downloads it, checks
LunarG's SHA-256, and extracts the SDK's own archives (Bin with `glslc`, Include,
Lib with `vulkan-1.lib`). CI uses the same script.

```sh
python scripts/assistant-vulkan-sdk.py 1.4.363.1 'S:\dev\tools\VulkanSDK' --7z 'S:\dev\tools\7zip-msi\Files\7-Zip\7z.exe'
```

### Shell setup (Git Bash)

New terminals get `VULKAN_SDK` and `UV_CACHE_DIR` from the user environment. Put
Node 22, the SDK's tools, CMake, Ninja, and uv first on `PATH`:

```sh
export VULKAN_SDK='S:/dev/tools/VulkanSDK'
VS="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake"
export PATH="/s/dev/tools/node22:/s/dev/tools/VulkanSDK/Bin:$VS/CMake/bin:$VS/Ninja:$HOME/.local/bin:$PATH"
```

## Models

- **Voice (Qwen3-TTS 1.7B Base)**: `~/.assistant/models/hf`, downloaded by
  `assistant\voice\scripts\setup.ps1` (or on first use).
- **Speech to text (Parakeet Unified English, 697 MB)**: Assistant reads the
  installed Hex's models (`%LOCALAPPDATA%\hex\models`) when Hex has any, as on
  GamerBox. Winserve has no Hex, so it uses `~/.assistant/models/stt`, and the
  audio engine **downloads the model there on first start** (about 40 s) along
  with the Silero speech detector. `ASSISTANT_STT_MODELS` overrides the folder.

## One-time setup (already done on Winserve)

```sh
cd assistant && pnpm install                                   # Core
powershell -ExecutionPolicy Bypass -File assistant/voice/scripts/setup.ps1   # voice venv + Qwen model
```

## Tests

```sh
cd assistant && pnpm -r test                                    # Core: 65 tests, ~70 s
cargo test --locked --profile ears-dev --bin assistant assistant   # the app: ~90 tests
~/.assistant/voice/venv/Scripts/python.exe -m unittest discover -s assistant/voice/tests   # voice: 21 tests
node scripts/assistant-update-test.mjs                          # install, update, rollback (below)
```

The first `cargo test` (or build) compiles everything: about 7 minutes for a
release build here.

**GPU.** CUDA works here (torch 2.11+cu128 sees the RTX 3070), so the voice
service runs for real; it needs about 5.5 GB of the card's 8 GB, beside Parakeet
on Vulkan (about 0.7 GB). The soak test (`scripts/assistant-soak/soak.mjs`) and
the update test both fit. Nothing needs a second GPU.

**Keep it quiet.** Tests that start the app use `ASSISTANT_AUDIO_SIM`
(simulated microphone and speakers: nothing plays, nothing is heard), a
throwaway `ASSISTANT_HOME`, and Core's scripted brain. Don't start the real app
(`target\release\assistant.exe`) with real audio on Winserve unless you mean to.

## Builds

```sh
sh scripts/assistant-build.sh          # target/release/assistant.exe (~7 min cold)
sh scripts/assistant-build.sh --dev    # target/ears-dev/assistant.exe (fast rebuilds)
bash scripts/assistant-package.sh      # dist/assistant-<label>-windows-x64.zip + .sha256 + manifest.json
```

`assistant-build.sh` finds the Vulkan SDK (`VULKAN_SDK`, else
`S:\dev\tools\VulkanSDK`, `D:\dev\tools\VulkanSDK`, `C:\VulkanSDK\*`) and VS
2022's CMake and Ninja. Packaging is described in [`docs/install.md`](install.md);
`ASSISTANT_CHANNEL=nightly` (or `stable`) stamps the build like CI does.

## Testing updates locally

`scripts/assistant-update-test.mjs` runs the whole update path against a local
copy of GitHub's releases API (`scripts/assistant-fake-feed.mjs`), in
`%TEMP%\assistant-update-test` (`--work <dir>` elsewhere, `--keep` keeps it):

1. `install-assistant.ps1` installs package A from the feed (download, checksum,
   unpack, a voice env made from the lock, `install.json`, the launcher).
2. The launcher starts A.
3. The feed's Nightly becomes B; Settings' Check and Update (sent through the
   sim control port) download, verify, unpack, hand over, and quit; B starts and
   confirms, and A stays as the previous version.
4. The feed's Nightly becomes C, whose Core is missing; it never confirms, so the
   supervisor rolls back to B and records why.

It needs a package in `dist/` first (`bash scripts/assistant-package.sh`). The
app can also be pointed at the fake feed by hand with
`ASSISTANT_UPDATE_API=http://127.0.0.1:7399`.
