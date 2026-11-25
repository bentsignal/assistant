# Test voices for `hex vera-audio sim` and `live`: Vera's lines and the
# user's interruptions, plus the voices.json manifest the simulator reads.
#   powershell -File scripts/vera-audio/make-voices.ps1 -Out <dir> [-Mouth <vera/mouth with node_modules>]
# Vera speaks through the v1 Mouth (Kokoro, the "vera" preset) when -Mouth
# points at a checkout with its node_modules installed, else Windows SAPI
# (Zira). The user is SAPI David and Zira at 16 kHz.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Mouth
)
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

function Speak-Sapi([string]$Voice, [string]$Text, [string]$Path) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($Voice)
  $synth.SetOutputToWaveFile($Path, $format)
  $synth.Speak($Text)
  $synth.Dispose()
}

$vera = [ordered]@{
  "vera_long" = "Sure. I checked the hex thread, and the build finished about ten minutes ago. Two tests failed in the audio module, both about device recovery. Do you want me to ask Claude to look at them, or should I start a new thread for it?"
  "vera_2"    = "On it. I've asked Codex to open the browser and check the deploy dashboard. I'll ping you when it's done, and I'll put a summary in your inbox."
  "vera_3"    = "Here's what's new. The T3 thread about the settings window is waiting for your input, Grok found three posts about the release, and the nightly build passed. Nothing else needs you right now."
  "vera_4"    = "Okay. I'll keep it short from now on. Let me know if you want the details later, and I can read them out one at a time while you cook."
}
$user = [ordered]@{
  "u1" = "Stop, ask Claude to fix them."
  "u2" = "Wait, start a new thread for that instead."
  "u3" = "No, just put it in my inbox."
  "u4" = "Hold on, what was the second one?"
  "u5" = "Vera, turn it down a bit."
  "u6" = "Okay, read me the first one."
}

$tsx = if ($Mouth) { Join-Path $Mouth "node_modules\.bin\tsx.cmd" } else { "" }
$manifest = [ordered]@{ vera = @(); user = @() }
foreach ($key in $vera.Keys) {
  $path = Join-Path $Out "$key.wav"
  if ($tsx -and (Test-Path $tsx)) {
    Push-Location $Mouth
    & $tsx src/cli.ts $vera[$key] --out $path | Out-Null
    Pop-Location
  } else {
    Speak-Sapi "Microsoft Zira Desktop" $vera[$key] $path
  }
  $manifest.vera += [ordered]@{ file = "$key.wav"; text = $vera[$key] }
}
# Each phrase by both voices, alternating, so the plans mix them.
foreach ($pass in @(@("david", "zira"), @("zira", "david"))) {
  $index = 0
  foreach ($key in $user.Keys) {
    $tag = $pass[$index % 2]
    $voice = if ($tag -eq "zira") { "Microsoft Zira Desktop" } else { "Microsoft David Desktop" }
    $file = "$($key)_$tag.wav"
    if (-not (Test-Path (Join-Path $Out $file))) {
      Speak-Sapi $voice $user[$key] (Join-Path $Out $file)
    }
    $manifest.user += [ordered]@{ file = $file; text = $user[$key] }
    $index++
  }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $Out "voices.json")
"wrote $Out"
