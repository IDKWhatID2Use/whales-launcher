# ---------------------------------------------------------------------------
# diff-evidence.ps1 - proves that the interaction behind a screenshot actually
# happened: each delivered image is pixel-diffed against the image of the SAME
# page in its untouched state (ASCII only).
#
# Note on capture modes: shots that contain a popup (menu flyout / dialog) are
# captured from the screen and are 1266x833, while plain window shots are
# 1280x840. ImageDiff refuses to compare different sizes, so pairs are chosen
# within the same mode.
#
# USAGE  powershell -File scripts\tutorial\diff-evidence.ps1
# ---------------------------------------------------------------------------
param(
    [string]$OutFile = 'F:\WhalesLauncher\.probe\tutorial-work\diff-evidence.json'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repoRoot 'scripts\audit\capture-core.ps1')
Initialize-WinAuditCore | Out-Null

$dir = Join-Path $repoRoot 'docs\assets\tutorial'

# label, before, after  (both file names inside docs/assets/tutorial)
$pairs = @(
    @('02 filter applied',        '01-instance-list.png',        '02-filter-needs-attention.png'),
    @('03 search typed',          '01-instance-list.png',        '03-search.png'),
    @('22 search extended',       '03-search.png',               '22-empty-search.png'),
    @('06 drawer opened',         '01-instance-list.png',        '06-log-drawer.png'),
    @('07 wizard opened',         '01-instance-list.png',        '07-wizard-step1-name.png'),
    @('08 wizard step 2',         '07-wizard-step1-name.png',    '08-wizard-step2-engine.png'),
    @('09 wizard step 3',         '07-wizard-step1-name.png',    '09-wizard-step3-template.png'),
    @('10 wizard step 4',         '07-wizard-step1-name.png',    '10-wizard-step4-isolation.png'),
    @('12 detail tab settings',   '11-detail-plugins.png',       '12-detail-settings.png'),
    @('13 detail tab saves',      '11-detail-plugins.png',       '13-detail-saves.png'),
    @('14 detail tab logs',       '11-detail-plugins.png',       '14-detail-logs.png'),
    @('17 navigated to engines',  '01-instance-list.png',        '17-engines.png'),
    @('18 navigated to settings', '01-instance-list.png',        '18-global-settings.png'),
    @('23 settings scrolled',     '18-global-settings.png',      '23-node-runtime.png'),
    @('05 card menu vs app menu', '04-app-menu.png',             '05-card-more-menu.png'),
    @('19 edit view vs menu',     '05-card-more-menu.png',       '19-edit-instance.png'),
    @('20 delete dialog vs menu', '05-card-more-menu.png',       '20-delete-confirm.png'),
    @('20 vs 19 (two dialogs)',   '19-edit-instance.png',        '20-delete-confirm.png'),
    @('16 crashed vs stopped',    '01-instance-list.png',        '16-crashed-card.png')
)

$rows = New-Object System.Collections.Generic.List[object]
foreach ($p in $pairs) {
    $a = Join-Path $dir $p[1]
    $b = Join-Path $dir $p[2]
    if (-not (Test-Path -LiteralPath $a) -or -not (Test-Path -LiteralPath $b)) {
        [void]$rows.Add([pscustomobject]@{ label = $p[0]; before = $p[1]; after = $p[2]; ok = $false; reason = 'file-not-found' })
        continue
    }
    $d = ([WinAuditCore]::ImageDiff($a, $b, 24) | ConvertFrom-Json)
    [void]$rows.Add([pscustomobject]@{
        label          = $p[0]
        before         = $p[1]
        after          = $p[2]
        ok             = $d.ok
        changedPixels  = $d.changedPixels
        totalPixels    = $d.totalPixels
        changedRatio   = $d.changedPixelRatio
        changedBox     = ($d.changedBox -join ',')
        reason         = $d.reason
    })
}

$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
[System.IO.File]::WriteAllText($OutFile, ($rows | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

Write-Host 'label | before -> after | changedPixels | changedRatio | changedBox'
foreach ($r in $rows) {
    if ($r.ok -ne $true) { Write-Host ("{0} | SKIPPED ({1})" -f $r.label, $r.reason); continue }
    Write-Host ("{0} | {1} -> {2} | {3}/{4} | {5} | {6}" -f $r.label, $r.before, $r.after, $r.changedPixels, $r.totalPixels, $r.changedRatio, $r.changedBox)
}
Write-Host ("diff evidence -> " + $OutFile)
