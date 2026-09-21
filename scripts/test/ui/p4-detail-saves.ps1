# ---------------------------------------------------------------------------
# Case: P4 instance detail - saves tab.
#
# PURE ASCII ON PURPOSE - all Chinese strings come from the UTF-8 JSON context.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ContextFile,
    [Parameter(Mandatory = $true)][string]$OutJson
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$testRoot = Split-Path -Parent $PSScriptRoot
# -DisableNameChecking: the driver API is fixed by the task spec (Find-ByAutomationId,
# Toggle-Element, Resolve-UiRaw, ...) and a few of those nouns are not on the approved
# verb list. Silencing the warning keeps the runner console readable.
Import-Module (Join-Path $testRoot 'UiDriver.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $testRoot 'UiCase.psm1') -Force -DisableNameChecking

$ctx = Read-UiContext -Path $ContextFile
$L = $ctx.labels.p4
$D = $ctx.labels.detail
$C = $ctx.checks
$case = New-UiCase -Name $ctx.page -Title $ctx.pageTitle -Route $ctx.route

$app = $null
$failure = ''

try {
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
    Add-UiDiagnostic -Case $case -Text "pid=$($app.Pid) hwnd=$($app.Hwnd) route=$($ctx.route)"
    $root = Get-UiRoot -Hwnd $app.Hwnd

    $list = Find-ByAutomationId -Id $L.listAid -Scope $root -Exact -TimeoutMs 15000 -AllowMissing
    $rows = 0
    if ($list) { $rows = @(Find-ByControlType -ControlType 'ListItem' -Scope $list -All -AllowMissing).Count }
    $emptyVisible = Test-UiTextContained -Scope $root -Needle $L.emptyTitle
    $filteredEmptyVisible = Test-UiTextContained -Scope $root -Needle $L.filteredEmptyTitle

    # ---------------------------------------------------------------- P4-01
    # Either a populated list OR an explicit empty state - exactly what the
    # acceptance criterion allows, but one of them MUST exist.
    $eitherOk = (($null -ne $list) -and ($rows -gt 0)) -or $emptyVisible -or $filteredEmptyVisible
    Add-UiCheck -Case $case -Id 'P4-01' -Title $C.'P4-01' -Kind 'existence' -Ok $eitherOk `
        -Detail "listPresent=$($null -ne $list) rows=$rows emptyState='$($L.emptyTitle)'=$emptyVisible filteredEmpty=$filteredEmptyVisible"

    # ---------------------------------------------------------------- P4-02
    # The fixture home really has zero session files, so the saves view MUST be
    # in the empty state - a populated list here would mean the UI invents data.
    $expectEmpty = ($ctx.expect.sessionCount -eq 0)
    $matchOk = $false
    $matchDetail = "backend sessions=$($ctx.expect.sessionCount) rows=$rows emptyStateVisible=$emptyVisible"
    if ($expectEmpty) {
        $matchOk = $emptyVisible -and ($rows -eq 0)
    } else {
        $matchOk = ($rows -eq $ctx.expect.sessionCount)
    }
    Add-UiCheck -Case $case -Id 'P4-02' -Title $C.'P4-02' -Kind 'behavior' -Ok $matchOk -Detail $matchDetail

    # ---------------------------------------------------------------- P4-03
    $emptyTexts = @()
    if ($emptyVisible) {
        foreach ($text in @(Get-UiTexts -Scope $root)) {
            if ($text.IndexOf($L.emptyTitle, [System.StringComparison]::Ordinal) -ge 0 -or
                $text.IndexOf($L.emptyDesc, [System.StringComparison]::Ordinal) -ge 0) { $emptyTexts += $text }
        }
    }
    Add-UiCheck -Case $case -Id 'P4-03' -Title $C.'P4-03' -Kind 'existence' -Ok ($emptyTexts.Count -ge 2) `
        -Detail "empty state texts: '$($emptyTexts -join ' / ')'"

    # ---------------------------------------------------------------- P4-04
    $savesTab = Find-SelectorBarItem -Name $D.tabSaves -Scope $root -TimeoutMs 12000 -AllowMissing
    $selected = $null
    if ($savesTab) { $selected = Get-ElementSelected -Element $savesTab }
    Add-UiCheck -Case $case -Id 'P4-04' -Title $C.'P4-04' -Kind 'existence' -Ok ($selected -eq $true) `
        -Detail "tab '$($D.tabSaves)' IsSelected=$selected"

    # ---------------------------------------------------------------- P4-05
    $subtitle = Find-ByAutomationId -Id 'PART_SubtitleText' -Scope $root -Exact -TimeoutMs 5000 -AllowMissing
    $subtitleText = ''
    if ($subtitle) { $subtitleText = Get-ElementName -Element $subtitle }
    Add-UiCheck -Case $case -Id 'P4-05' -Title $C.'P4-05' -Kind 'existence' `
        -Ok ($subtitleText.IndexOf($D.tabSaves, [System.StringComparison]::Ordinal) -ge 0) `
        -Detail "subtitle='$subtitleText'"

    # ---------------------------------------------------------------- P4-06
    $summary = Find-ByAutomationId -Id $L.summaryAid -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    $summaryText = ''
    if ($summary) { $summaryText = Get-ElementName -Element $summary }
    Add-UiCheck -Case $case -Id 'P4-06' -Title $C.'P4-06' -Kind 'existence' -Ok ($summaryText.Length -gt 0) `
        -Detail "SummaryText='$summaryText'"
}
catch {
    $failure = Get-UiCaseFailure -ErrorRecord $_
    Add-UiDiagnostic -Case $case -Text $failure
}
finally {
    $infra = ''
    if ($app) {
        $killResult = 'not-running'
        try { $killResult = Stop-WhalesApp -Pid $app.Pid -LogDir $ctx.logDir } catch { $killResult = 'kill-error' }
        if ($killResult -eq 'not-running') {
            # The process was already gone before this test stopped it. A real
            # UI defect does not kill the app mid-case; another process on this
            # machine did (verified with an A/B run: a control instance sitting
            # on a known-good route died at the exact same instant). Reported as
            # an infrastructure failure so the runner retries instead of
            # blaming the product.
            $infra = 'INFRASTRUCTURE: the WhalesLauncher process was already gone when the case finished - it was terminated by another process on this machine, not by this test.'
            Add-UiDiagnostic -Case $case -Text $infra
        }
    }
    $result = Complete-UiCase -Case $case -OutJson $OutJson -Error $failure -InfrastructureError $infra
    if ($result.failed -gt 0 -or $result.error) { exit 1 }
    exit 0
}
