# Sets up Vera's voice service in ~/.vera/voice/venv and downloads its models to
# ~/.vera/models. Safe to run again (it only fetches what's missing).
#
#   powershell -ExecutionPolicy Bypass -File vera\voice\scripts\setup.ps1 [-Dev] [-NoModels]
#
# -Dev       install the package editable (changes in the repo apply without re-running)
# -NoModels  skip model downloads (they also download on first use)
param([switch]$Dev, [switch]$NoModels)
$ErrorActionPreference = "Stop"

$Project = Resolve-Path (Join-Path $PSScriptRoot "..")
$Vera = if ($env:VERA_HOME) { $env:VERA_HOME } else { Join-Path $HOME ".vera" }
$Venv = Join-Path $Vera "voice\venv"
$Models = Join-Path $Vera "models"
New-Item -ItemType Directory -Force (Join-Path $Vera "voice"), (Join-Path $Vera "logs"), $Models | Out-Null

# 1. uv (Astral's Python manager); installs to ~/.local/bin
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { $uv = Join-Path $HOME ".local\bin\uv.exe" }
if (-not (Test-Path $uv)) {
    Write-Host "Installing uv..."
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
}

# 2. The venv: a uv-managed CPython 3.12 with the locked dependencies (CUDA 12.8 torch)
Write-Host "Syncing $Venv ..."
$env:UV_PROJECT_ENVIRONMENT = $Venv
$sync = @("sync", "--project", $Project, "--frozen", "--python", "3.12", "--managed-python")
if (-not $Dev) { $sync += "--no-editable" }
& $uv @sync
if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }
$py = Join-Path $Venv "Scripts\python.exe"

# 3. Models
if (-not $NoModels) {
    $env:HF_HOME = Join-Path $Models "hf"
    $env:HF_HUB_DISABLE_TELEMETRY = "1"
    Write-Host "Downloading Qwen3-TTS 1.7B Base (about 4.5 GB, once)..."
    & $py -c "from huggingface_hub import snapshot_download as s; s('Qwen/Qwen3-TTS-12Hz-1.7B-Base')"
    if ($LASTEXITCODE -ne 0) { throw "Qwen download failed" }

    $k = Join-Path $Models "kokoro-onnx"
    New-Item -ItemType Directory -Force $k | Out-Null
    foreach ($f in "kokoro-v1.0.onnx", "voices-v1.0.bin") {
        $dest = Join-Path $k $f
        if (-not (Test-Path $dest)) {
            Write-Host "Downloading Kokoro $f ..."
            curl.exe -sSL -o "$dest.part" "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f"
            if ($LASTEXITCODE -ne 0) { throw "Kokoro download failed" }
            Move-Item -Force "$dest.part" $dest
        }
    }
}

$hidden = Join-Path $Venv "Scripts\pythonw.exe"
Write-Host ""
Write-Host "Done. Start the service (no console window):"
Write-Host "  `"$hidden`" -m vera_voice serve --port 7314"
Write-Host "Try it from a terminal:"
Write-Host "  `"$py`" -m vera_voice say `"On it. I'll ping you when it's done.`""
