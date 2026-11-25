# Speaks the Vera Ears test phrases with Windows SAPI into 16 kHz mono WAVs.
#   powershell -File scripts/assistant-ears/make-voices.ps1 -Out <dir>
param([Parameter(Mandatory = $true)][string]$Out)
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$phrases = [ordered]@{
  "p1_status"   = "Vera, what's the status of my T3 threads?"
  "p2_followup" = "Also, can you tell me which one finished last?"
  "p3_heyvera"  = "Hey Vera, start a new thread in the hex project."
  "p4_vera"     = "Vera."
  "p5_long"     = "Vera, I want you to check on the build, and then, when it is done, tell me how long it took."
  "p6_noprefix" = "Set a timer for ten minutes please."
}
foreach ($voice in @("Microsoft Zira Desktop", "Microsoft David Desktop")) {
  $tag = if ($voice -like "*Zira*") { "zira" } else { "david" }
  foreach ($key in $phrases.Keys) {
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.SelectVoice($voice)
    $synth.SetOutputToWaveFile((Join-Path $Out "$($key)_$tag.wav"), $format)
    $synth.Speak($phrases[$key])
    $synth.Dispose()
  }
}
