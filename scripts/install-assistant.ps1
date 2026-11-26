# Installs Assistant from a release, per user, with no admin rights (docs/install.md).
# Safe on a PC that runs the old repo build: it quits that build, moves start-at-login to
# the installed launcher, and leaves ~/.assistant (config, prompt, history, voices, models,
# the voice venv) exactly where it is. Run it again to reinstall or repair.
#
#   powershell -ExecutionPolicy Bypass -File install-assistant.ps1 [-Channel stable|nightly]
#       [-Tag v2.0.0] [-Zip <package.zip> -Manifest <manifest.json>] [-Root <folder>] [-NoStart]
#
#   -Channel   which channel's current release (default stable; nightly if there's no stable yet)
#   -Tag       a specific release tag instead (nightly or vX.Y.Z)
#   -Zip       install a package already on disk (with its -Manifest) instead of downloading
#   -Root      install folder (default %LOCALAPPDATA%\Programs\Assistant)
#   -Api       a GitHub-compatible API (default https://api.github.com; tests use the fake feed)
#   -NoLogin   leave start at login alone (tests)
#   -NoStart   don't start it afterwards
param(
    [ValidateSet("stable", "nightly")][string]$Channel = "stable",
    [string]$Tag,
    [string]$Zip,
    [string]$Manifest,
    [string]$Root = (Join-Path $env:LOCALAPPDATA "Programs\Assistant"),
    [string]$Repo = "bentsignal/assistant",
    [string]$Api = "https://api.github.com",
    [switch]$NoLogin,
    [switch]$NoStart
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$headers = @{ "User-Agent" = "assistant-installer"; "Accept" = "application/vnd.github+json" }

function Get-Release([string]$tag) {
    try { Invoke-RestMethod -UseBasicParsing -Headers $headers "$Api/repos/$Repo/releases/tags/$tag" }
    catch { $null }
}

function Get-LatestStable {
    $list = Invoke-RestMethod -UseBasicParsing -Headers $headers "$Api/repos/$Repo/releases?per_page=50"
    $list | Where-Object { -not $_.draft -and -not $_.prerelease -and $_.tag_name -match '^v\d+\.\d+\.\d+$' } |
        Sort-Object { [version]($_.tag_name.Substring(1)) } -Descending | Select-Object -First 1
}

# 1. Which release, and its manifest.
$temp = Join-Path $env:TEMP ("assistant-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $temp | Out-Null
if ($Zip) {
    if (-not $Manifest) { throw "-Zip needs -Manifest" }
    $info = Get-Content -Raw $Manifest | ConvertFrom-Json
    $package = (Resolve-Path $Zip).Path
} else {
    $release = if ($Tag) { Get-Release $Tag }
               elseif ($Channel -eq "nightly") { Get-Release "nightly" }
               else { Get-LatestStable }
    if (-not $release -and -not $Tag -and $Channel -eq "stable") {
        Write-Host "No stable release yet; installing Nightly."
        $release = Get-Release "nightly"
    }
    if (-not $release) { throw "No release found in $Repo" }
    $manifestAsset = $release.assets | Where-Object name -eq "manifest.json"
    if (-not $manifestAsset) { throw "Release $($release.tag_name) has no manifest.json" }
    $info = Invoke-RestMethod -UseBasicParsing -Headers @{ "User-Agent" = "assistant-installer" } $manifestAsset.browser_download_url
    $asset = $release.assets | Where-Object name -eq $info.asset.name
    if (-not $asset) { throw "Release $($release.tag_name) has no $($info.asset.name)" }
    $package = Join-Path $temp $info.asset.name
    Write-Host "Downloading $($info.label) ($([math]::Round($info.asset.size / 1MB)) MB)..."
    Invoke-WebRequest -UseBasicParsing -Headers @{ "User-Agent" = "assistant-installer" } $asset.browser_download_url -OutFile $package
}
$label = $info.label
if ($label -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Bad release label '$label'" }

# 2. Verify it.
$hash = (Get-FileHash -Algorithm SHA256 $package).Hash.ToLower()
if ($hash -ne $info.asset.sha256.ToLower()) { throw "Checksum mismatch for $package ($hash)" }
Write-Host "Verified $($info.asset.name) (sha256 $hash)"

# 3. Quit whatever Assistant runs now (the old repo build, or an installed one), and its
#    children with it (they live in its job object).
$running = Get-Process -Name assistant -ErrorAction SilentlyContinue | Where-Object { $_.Path }
foreach ($p in $running) {
    Write-Host "Quitting the running Assistant ($($p.Path))..."
    Start-Process -FilePath $p.Path -ArgumentList "quit" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
}
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Process -Name assistant -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
Get-Process -Name assistant -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# 4. Unpack into versions\<label> (through a .partial folder).
$versions = Join-Path $Root "versions"
$dest = Join-Path $versions $label
$partial = Join-Path $versions ".$label.partial"
New-Item -ItemType Directory -Force $versions | Out-Null
if (Test-Path $partial) { Remove-Item -Recurse -Force $partial }
New-Item -ItemType Directory -Force $partial | Out-Null
& "$env:SystemRoot\System32\tar.exe" -xf $package -C $partial
if ($LASTEXITCODE -ne 0) { throw "Could not unpack $package" }
$pkg = Get-Content -Raw (Join-Path $partial "assistant-package.json") | ConvertFrom-Json
if ($pkg.label -ne $label) { throw "The package says $($pkg.label), the manifest $label" }
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Rename-Item $partial $label

# 5. Make it the installed version: the voice venv for its lock (the existing
#    ~/.assistant/voice/venv is synced in place, quickly when little changed), install.json,
#    the launcher at <root>\assistant.exe, and the Start Menu shortcut.
$exe = Join-Path $dest "assistant.exe"
Write-Host "Setting up $label (the voice's Python packages can take a few minutes the first time)..."
$p = Start-Process -FilePath $exe -ArgumentList "install-self" -NoNewWindow -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "install-self failed (exit $($p.ExitCode)); see ~\.assistant\logs\updater.log" }

# 6. Start at login: the launcher, never the repo build (the app keeps this up to date too).
$run = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$launcher = Join-Path $Root "assistant.exe"
if (-not $NoLogin) {
    $old = (Get-ItemProperty -Path $run -Name Assistant -ErrorAction SilentlyContinue).Assistant
    if ($old) { Write-Host "Start at login was: $old" }
    Set-ItemProperty -Path $run -Name Assistant -Value "`"$launcher`" --hidden"
    Remove-ItemProperty -Path $run -Name Vera -ErrorAction SilentlyContinue
    Write-Host "Start at login is now: `"$launcher`" --hidden"
}

# 7. Overrides in config.json that would bypass the installed copy.
$config = Join-Path $HOME ".assistant\config.json"
if (Test-Path $config) {
    $app = (Get-Content -Raw $config | ConvertFrom-Json).app
    foreach ($key in @("core", "voiceService")) {
        if ($app -and $app.$key -and $app.$key.command) {
            Write-Warning "config.json sets app.$key.command; it overrides the installed $key. Remove it to use the installed one."
        }
    }
}

Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
Write-Host "Installed Assistant $label in $Root"
if (-not $NoStart) {
    Start-Process -FilePath $launcher
    Write-Host "Started it (Settings opens; it lives in the tray)."
}
