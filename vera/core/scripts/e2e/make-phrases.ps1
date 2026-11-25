# Speaks the Vera end-to-end test phrases with Windows SAPI into 16 kHz mono WAVs.
#   powershell -File vera/core/scripts/e2e/make-phrases.ps1 -Out <dir>
param([Parameter(Mandatory = $true)][string]$Out)
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$phrases = [ordered]@{
  "nowake"   = "Okay, the pasta needs about ten more minutes."
  "time"     = "Vera, what time is it?"
  "followup" = "And what day is it today?"
  "late"     = "I think the sauce needs a little more salt."
  "fact"     = "Hey Vera, tell me a long fun fact about tomatoes."
  "stop"     = "Vera, stop."
  "variable" = "Variable, what is two plus two?"
}
foreach ($key in $phrases.Keys) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice("Microsoft David Desktop")
  $synth.SetOutputToWaveFile((Join-Path $Out "$key.wav"), $format)
  $synth.Speak($phrases[$key])
  $synth.Dispose()
}
