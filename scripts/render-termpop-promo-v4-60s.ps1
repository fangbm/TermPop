param(
  [string]$OutputPath = "artifacts/termpop-promo-v4-60s-16x9.mp4",
  [switch]$SkipFrameRender
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$ffmpeg = "D:\Program Files\ffmpeg\bin\ffmpeg.exe"
$renderer = Join-Path $PSScriptRoot "render-termpop-promo-v4-60s.mjs"
$framesDir = Join-Path $repoRoot "artifacts\promo-v4-60s-frames"
$assetsDir = Join-Path $repoRoot "artifacts\promo-v3-assets"
$music = Join-Path $assetsDir "mixkit-close-up-1167.mp3"
$clickSample = Join-Path $PSScriptRoot "assets\termpop-mouse-click.wav"
$destination = Join-Path $repoRoot $OutputPath
$duration = 60
$fps = 30

foreach ($required in @($node, $ffmpeg, $renderer, $clickSample)) {
  if (!(Test-Path $required)) { throw "Missing required tool or source: $required" }
}

New-Item -ItemType Directory -Force -Path $assetsDir, (Split-Path -Parent $destination) | Out-Null

# Close Up by Michael Ramir C., Mixkit Stock Music Free License.
# Source: https://assets.mixkit.co/music/1167/1167.mp3
# License: https://mixkit.co/license/#musicFree
if (!(Test-Path $music)) {
  Invoke-WebRequest -Uri "https://assets.mixkit.co/music/1167/1167.mp3" -OutFile $music
}

if (!$SkipFrameRender) {
  $env:TERMPOP_PROMO_FPS = "$fps"
  $env:TERMPOP_PROMO_DURATION = "$duration"
  & $node $renderer
  if ($LASTEXITCODE -ne 0) { throw "Frame rendering failed with exit code $LASTEXITCODE" }
}

$filter = @(
  "[1:a]atrim=0:$duration,asetpts=PTS-STARTPTS,volume=0.60,afade=t=in:st=0:d=0.45,afade=t=out:st=58.55:d=1.45[music]",
  "[2:a]volume=0.10,afade=t=out:st=0.045:d=0.035,adelay=7820|7820[p1]",
  "[3:a]volume=0.09,afade=t=out:st=0.05:d=0.04,adelay=10140|10140[p2]",
  "[4:a]volume=1.05,adelay=20220|20220[p3]",
  "[5:a]volume=1.05,adelay=22100|22100[p4]",
  "[6:a]volume=0.10,afade=t=out:st=0.045:d=0.035,adelay=32020|32020[p5]",
  "[7:a]volume=0.09,afade=t=out:st=0.05:d=0.04,adelay=33000|33000[p6]",
  "[8:a]volume=0.10,afade=t=out:st=0.05:d=0.04,adelay=42080|42080[p7]",
  "[9:a]volume=0.09,afade=t=out:st=0.05:d=0.04,adelay=49100|49100[p8]",
  "[10:a]volume=0.11,afade=t=out:st=0.055:d=0.04,adelay=53160|53160[p9]",
  "[music][p1][p2][p3][p4][p5][p6][p7][p8][p9]amix=inputs=10:normalize=0,alimiter=limit=.92[a]"
) -join ";"

& $ffmpeg -y `
  -framerate $fps -i (Join-Path $framesDir "frame-%05d.jpg") `
  -i $music `
  -f lavfi -i "sine=frequency=920:sample_rate=48000:duration=0.08" `
  -f lavfi -i "sine=frequency=620:sample_rate=48000:duration=0.09" `
  -i $clickSample `
  -i $clickSample `
  -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=0.08" `
  -f lavfi -i "sine=frequency=460:sample_rate=48000:duration=0.10" `
  -f lavfi -i "sine=frequency=740:sample_rate=48000:duration=0.09" `
  -f lavfi -i "sine=frequency=580:sample_rate=48000:duration=0.09" `
  -f lavfi -i "sine=frequency=940:sample_rate=48000:duration=0.10" `
  -filter_complex $filter `
  -map 0:v:0 -map "[a]" `
  -t $duration -r $fps `
  -vf "scale=in_range=full:out_range=tv,format=yuv420p" `
  -c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 -crf 17 -preset medium `
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart `
  $destination

if ($LASTEXITCODE -ne 0) { throw "Video encoding failed with exit code $LASTEXITCODE" }

$audioNote = @"
# TermPop promo audio

- Track: Close Up
- Artist: Michael Ramir C.
- Source: https://assets.mixkit.co/music/1167/1167.mp3
- License: Mixkit Stock Music Free License
- License URL: https://mixkit.co/license/#musicFree

- Sound effect: Mouse click close
- Source: https://mixkit.co/free-sound-effects/click/
- Asset ID: 1113
- License: Mixkit Sound Effects Free License
- License URL: https://mixkit.co/license/#sfxFree
"@
Set-Content -LiteralPath "$destination.audio.md" -Value $audioNote -Encoding UTF8

$renderInfo = [ordered]@{
  source = "scripts/termpop-promo-v4-60s.html"
  duration_seconds = $duration
  fps = $fps
  resolution = "1920x1080"
  codec = "H.264 High / yuv420p"
  audio = "AAC 48kHz 192kbps"
  rendered_at = (Get-Date).ToString("o")
}
$renderInfo | ConvertTo-Json | Set-Content -LiteralPath "$destination.render.json" -Encoding UTF8

Write-Host "Created $destination"
