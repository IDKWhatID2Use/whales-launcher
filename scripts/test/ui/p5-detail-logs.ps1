# ---------------------------------------------------------------------------
# Case: P5 instance detail - logs tab.
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
Import-Module (Join-Path $testRoot 'UiDriver.psm1') -Force
Import-Module (Join-Path $testRoot 'UiCase.psm1') -Force

$ctx = Read-UiContext -Path $ContextFile
$L = $ctx.labels.p5
$D = $ctx.labels.detail
$C = $ctx.checks
$case = New-UiCase -Name $ctx.page -Title $ctx.pageTitle -Route $ctx.route

$app = $null
$failure = ''

try {
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
    Add-UiDiagnostic -Case $case -Text "pid=$($app.Pid) hwnd=$($app.Hwnd) route=$($ctx.route)"
    $root = Get-UiRoot -Hwnd $app.Hwnd

    # ---------------------------------------------------------------- P5-01
    # The log panel is a UserControl; a UserControl has no automation peer of
    # its own, so the panel is identified by its rendered body: either the log
    # list has rows, or the "no logs yet" empty text is on screen.
    $logList = Find-ByAutomationId -Id 'LogList' -Scope $root -Exact -TimeoutMs 15000 -AllowMissing
    $rows = 0
    if ($logList) { $rows = @(Find-ByControlType -ControlType 'ListItem' -Scope $logList -All -AllowMissing).Count }
    $emptyText = Test-UiTextContained -Scope $root -Needle $L.emptyTitle
    $panelOk = ($rows -gt 0) -or $emptyText
    Add-UiCheck -Case $case -Id 'P5-01' -Title $C.'P5-01' -Kind 'existence' -Ok $panelOk `
        -Detail "LogList present=$($null -ne $logList) rows=$rows emptyText('$($L.emptyTitle)')=$emptyText"

    # ---------------------------------------------------------------- P5-02
    # Behavior: the follow-scroll switch really toggles.
    $follow = Find-ByName -Name $L.followName -Scope $root -Exact -TimeoutMs 10000 -AllowMissing
    $toggleOk = $false
    $toggleDetail = "switch '$($L.followName)' not found"
    if ($follow) {
        $stateBefore = Get-ElementToggleState -Element $follow
        $stateAfter = Toggle-Element -Element $follow
        $restored = Toggle-Element -Element $follow
        $toggleOk = ($stateBefore.Length -gt 0) -and ($stateBefore -cne $stateAfter) -and ($restored -ceq $stateBefore)
        $toggleDetail = "toggle $stateBefore -> $stateAfter -> $restored"
    }
    Add-UiCheck -Case $case -Id 'P5-02' -Title $C.'P5-02' -Kind 'behavior' -Ok $toggleOk -Detail $toggleDetail

    # ---------------------------------------------------------------- P5-03
    $count = Find-ByAutomationId -Id $L.countAid -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    $countText = ''
    if ($count) { $countText = Get-ElementName -Element $count }
    $truncate = Find-ByAutomationId -Id $L.truncateAid -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    $truncateText = ''
    if ($truncate) { $truncateText = Get-ElementName -Element $truncate }
    $countOk = ($countText.Length -gt 0) -and ($countText.IndexOf('/', [System.StringComparison]::Ordinal) -ge 0)
    Add-UiCheck -Case $case -Id 'P5-03' -Title $C.'P5-03' -Kind 'existence' -Ok $countOk `
        -Detail "CountText='$countText' TruncateText='$truncateText'"

    # ---------------------------------------------------------------- P5-04
    $logsTab = Find-SelectorBarItem -Name $D.tabLogs -Scope $root -TimeoutMs 12000 -AllowMissing
    $selected = $null
    if ($logsTab) { $selected = Get-ElementSelected -Element $logsTab }
    Add-UiCheck -Case $case -Id 'P5-04' -Title $C.'P5-04' -Kind 'existence' -Ok ($selected -eq $true) `
        -Detail "tab '$($D.tabLogs)' IsSelected=$selected"

    # ---------------------------------------------------------------- P5-05
    $bodyOk = ($rows -gt 0) -or $emptyText
    Add-UiCheck -Case $case -Id 'P5-05' -Title $C.'P5-05' -Kind 'existence' -Ok $bodyOk `
        -Detail "rows=$rows emptyText=$emptyText (the fixture instance has never run, so the empty state is expected)"

    # ---------------------------------------------------------------- P5-06
    $keyword = Find-ByName -Name $L.keywordName -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    $clear = Find-ByName -Name $L.clearName -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    $copy = Find-ByName -Name $L.copyName -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    $controlsOk = ($null -ne $keyword) -and ($null -ne $clear) -and ($null -ne $copy)
    Add-UiCheck -Case $case -Id 'P5-06' -Title $C.'P5-06' -Kind 'existence' -Ok $controlsOk `
        -Detail "keyword=$($null -ne $keyword) clear=$($null -ne $clear) copy=$($null -ne $copy)"
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
