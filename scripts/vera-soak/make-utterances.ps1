# The soak test's "Shawn": each line of a JSON list ({"name","text"}) said by
# Windows SAPI (David) into <Out>\<name>.wav, 16 kHz mono. Existing files
# with the same text are kept (a .txt beside each WAV records its text).
#   powershell -File scripts/vera-soak/make-utterances.ps1 -List <lines.json> -Out <dir>
param(
  [Parameter(Mandatory = $true)][string]$List,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Voice = "Microsoft David Desktop"
)
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$lines = Get-Content -Raw $List | ConvertFrom-Json
foreach ($line in $lines) {
  $wav = Join-Path $Out "$($line.name).wav"
  $txt = Join-Path $Out "$($line.name).txt"
  if ((Test-Path $wav) -and (Test-Path $txt) -and ((Get-Content -Raw $txt).Trim() -eq $line.text)) { continue }
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $synth.SelectVoice($Voice) } catch {}
  $synth.Rate = 0
  $synth.SetOutputToWaveFile($wav, $format)
  $synth.Speak($line.text)
  $synth.Dispose()
  Set-Content -NoNewline -Path $txt -Value $line.text
  Write-Output "made $($line.name)"
}
