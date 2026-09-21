# ---------------------------------------------------------------------------
# evidence.ps1 - pixel evidence for every tutorial screenshot (ASCII only).
#
# For each PNG it reports the measurements that prove the image is a real
# rendered window and not a blank/black placeholder:
#   distinctColorsExact        - number of distinct RGB values (sampled)
#   distinctColorsQuantized    - distinct 4-bit-per-channel colours
#   nonBackgroundPixelRatio    - share of pixels that differ from the dominant
#                                background colour (i.e. how much content there is)
#   blackishPixelRatio         - share of near-black pixels (a black capture would
#                                be ~1.0)
#   contentLumaSpread          - contrast between the 0.5% and 99.5% luma
# percentiles of content pixels
# It also records width/height and the SHA-256 of the file.
#
# USAGE  powershell -File scripts\tutorial\evidence.ps1 [-OutFile <path>]
# ---------------------------------------------------------------------------
param(
    [string]$OutFile = 'F:\WhalesLauncher\.probe\tutorial-work\evidence.json'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repoRoot 'scripts\audit\capture-core.ps1')
Initialize-WinAuditCore | Out-Null

$tutorialDir = Join-Path $repoRoot 'docs\assets\tutorial'
$assetsDir = Join-Path $repoRoot 'docs\assets'

$rows = New-Object System.Collections.Generic.List[object]

function Add-Evidence {
    param([string]$Label, [string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        [void]$rows.Add([pscustomobject]@{ label = $Label; path = $Path; ok = $false; reason = 'file-not-found' })
        return
    }
    $stats = ([WinAuditCore]::ImageStats($Path) | ConvertFrom-Json)
    [void]$rows.Add([pscustomobject]@{
        label            = $Label
        path             = $Path
        ok               = $stats.ok
        bytes            = (Get-Item -LiteralPath $Path).Length
        sha256           = ([WinAuditCore]::Sha256OfFile($Path)).Substring(0, 16)
        width            = $stats.width
        height           = $stats.height
        distinctExact    = $stats.distinctColorsExact
        distinctQuant    = $stats.distinctColorsQuantized
        nonBgRatio       = $stats.nonBackgroundPixelRatio
        blackishRatio    = $stats.blackishPixelRatio
        meanLuma         = $stats.meanLuma
        lumaSpread       = $stats.contentLumaSpread
        backgroundShare  = $stats.backgroundShare
        backgroundRgb    = ($stats.backgroundRgb -join ',')
    })
}

Get-ChildItem -LiteralPath $tutorialDir -Filter *.png | Sort-Object Name | ForEach-Object {
    Add-Evidence -Label $_.Name -Path $_.FullName
}
Get-ChildItem -LiteralPath $assetsDir -Filter 'screenshot-*.png' | Sort-Object Name | ForEach-Object {
    Add-Evidence -Label ('docs/assets/' + $_.Name) -Path $_.FullName
}

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$json = $rows | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ('label | size | distinctExact | distinctQuant | nonBgRatio | blackishRatio | lumaSpread')
foreach ($r in $rows) {
    if ($r.ok -ne $true) {
        Write-Host ("{0} | MISSING" -f $r.label)
        continue
    }
    Write-Host ("{0} | {1}x{2} | {3} | {4} | {5} | {6} | {7}" -f $r.label, $r.width, $r.height, $r.distinctExact, $r.distinctQuant, $r.nonBgRatio, $r.blackishRatio, $r.lumaSpread)
}
Write-Host ("evidence -> " + $OutFile)
