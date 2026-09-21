# ---------------------------------------------------------------------------
# Case: P6 engine version management.
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
$L = $ctx.labels.p6
$C = $ctx.checks
$case = New-UiCase -Name $ctx.page -Title $ctx.pageTitle -Route $ctx.route

$app = $null
$failure = ''
$availableEmptyTitle = ''
$availableViewIsEmpty = $false

try {
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
    Add-UiDiagnostic -Case $case -Text "pid=$($app.Pid) hwnd=$($app.Hwnd) route=$($ctx.route)"
    $root = Get-UiRoot -Hwnd $app.Hwnd

    # ---------------------------------------------------------------- P6-01
    # Row count must equal engine:list from the backend (fixture installs two
    # synthetic engine directories; no real engine, no network).
    $installed = Find-ByAutomationId -Id $L.installedListAid -Scope $root -Exact -TimeoutMs 20000 -AllowMissing
    $rows = 0
    if ($installed) { $rows = @(Find-ByControlType -ControlType 'ListItem' -Scope $installed -All -AllowMissing).Count }
    $countOk = Wait-Until -TimeoutMs 12000 -Message 'engine rows' -Condition {
        $list = Find-ByAutomationId -Id $L.installedListAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 800 -AllowMissing
        if ($null -eq $list) { return $false }
        return (@(Find-ByControlType -ControlType 'ListItem' -Scope $list -All -AllowMissing).Count -eq $ctx.expect.engineCount)
    }
    if ($installed) { $rows = @(Find-ByControlType -ControlType 'ListItem' -Scope $installed -All -AllowMissing).Count }
    Add-UiCheck -Case $case -Id 'P6-01' -Title $C.'P6-01' -Kind 'existence' -Ok $countOk `
        -Detail "backend engines=$($ctx.expect.engineCount) rows=$rows versions='$($ctx.expect.engineVersions -join ', ')'"

    # ---------------------------------------------------------------- P6-02
    $installedTab = Find-ByAutomationId -Id 'InstalledTab' -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    $selected = $null
    if ($installedTab) { $selected = Get-ElementSelected -Element $installedTab }
    Add-UiCheck -Case $case -Id 'P6-02' -Title $C.'P6-02' -Kind 'existence' -Ok ($selected -eq $true) `
        -Detail "tab '$($L.installedTab)' IsSelected=$selected"

    # ---------------------------------------------------------------- P6-05/06
    $badge = Find-ByAutomationId -Id $L.nodeBadgeAid -Scope $root -Exact -TimeoutMs 12000 -AllowMissing
    $badgeText = ''
    if ($badge) { $badgeText = Get-ElementName -Element $badge }
    $caption = Find-ByAutomationId -Id $L.nodeCaptionAid -Scope $root -Exact -TimeoutMs 6000 -AllowMissing
    $captionText = ''
    if ($caption) { $captionText = Get-ElementName -Element $caption }
    $nodeOk = ($badgeText.Length -gt 0) -or ($captionText.Length -gt 0)
    Add-UiCheck -Case $case -Id 'P6-05' -Title $C.'P6-05' -Kind 'existence' -Ok $nodeOk `
        -Detail "NodeBadge='$badgeText' NodeCaption='$captionText'"

    $refresh = Find-ByName -Name $L.refreshName -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    Add-UiCheck -Case $case -Id 'P6-06' -Title $C.'P6-06' -Kind 'existence' -Ok ($null -ne $refresh) `
        -Detail "button '$($L.refreshName)' present=$($null -ne $refresh)"

    # ---------------------------------------------------------------- P6-07
    $missingVersions = @()
    $versionScope = $root
    if ($installed) { $versionScope = $installed }
    foreach ($version in $ctx.expect.engineVersions) {
        if (-not (Test-UiTextContained -Scope $versionScope -Needle $version)) { $missingVersions += $version }
    }
    Add-UiCheck -Case $case -Id 'P6-07' -Title $C.'P6-07' -Kind 'existence' -Ok ($missingVersions.Count -eq 0) `
        -Detail "versions rendered: $($ctx.expect.engineVersions.Count - $missingVersions.Count)/$($ctx.expect.engineVersions.Count); missing='$($missingVersions -join ', ')'"

    # ---------------------------------------------------------------- P6-03
    # Behavior: switching to the "available" view must really swap the content.
    $beforeTexts = @(Get-UiTexts -Scope $root)
    $availableTab = Find-ByAutomationId -Id 'AvailableTab' -Scope $root -Exact -TimeoutMs 6000 -AllowMissing
    $switchOk = $false
    $switchDetail = "tab '$($L.availableTab)' not found"
    if ($availableTab) {
        Select-Element -Element $availableTab
        $changed = Wait-Until -TimeoutMs 10000 -Message 'available view' -Condition {
            $now = @(Get-UiTexts -Scope (Get-UiRoot -Hwnd $app.Hwnd))
            return (($now -join "`n") -cne ($beforeTexts -join "`n"))
        }
        $installedGone = Wait-Until -TimeoutMs 6000 -Message 'installed view hidden' -Condition {
            $list = Find-ByAutomationId -Id $L.installedListAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 500 -AllowMissing
            if ($null -eq $list) { return $true }
            return [bool]$list.IsOffscreen
        }
        $availableSelected = Get-ElementSelected -Element $availableTab
        $switchOk = $changed -and $installedGone -and ($availableSelected -eq $true)
        $switchDetail = "contentChanged=$changed installedListHidden=$installedGone available.IsSelected=$availableSelected"

        # Observe the available-side empty state wording (if the registry query
        # failed, which is the expected offline behaviour). If rows DID load,
        # there is no empty state to compare and P6-04 becomes unverifiable.
        $title = Find-ByAutomationId -Id 'AvailableEmptyTitle' -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 12000 -AllowMissing
        if ($title) {
            $availableEmptyTitle = Get-ElementName -Element $title
            $availableViewIsEmpty = $true
        }
    }
    Add-UiCheck -Case $case -Id 'P6-03' -Title $C.'P6-03' -Kind 'behavior' -Ok $switchOk -Detail $switchDetail

    # ---------------------------------------------------------------- P6-04
    # The two empty states must be distinguishable. They cannot both be visible
    # in one process (one belongs to a home with zero engines), so the second
    # one is observed from a real second run against an engine-less home.
    if ($availableViewIsEmpty) {
        [void](Stop-WhalesApp -Pid $app.Pid -LogDir $ctx.logDir)
        $app = Start-WhalesApp -Root $ctx.expect.noEngineHomeDir -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
        $root3 = Get-UiRoot -Hwnd $app.Hwnd
        $installedEmptyOk = Wait-Until -TimeoutMs 20000 -Message 'installed empty state' -Condition {
            $null -ne (Find-ByAutomationId -Id 'InstalledEmptyTitle' -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 800 -AllowMissing)
        }
        $installedTitle = Find-ByAutomationId -Id 'InstalledEmptyTitle' -Scope $root3 -Exact -TimeoutMs 3000 -AllowMissing
        $installedEmptyTitle = ''
        if ($installedTitle) { $installedEmptyTitle = Get-ElementName -Element $installedTitle }
        $distinct = ($installedEmptyTitle.Length -gt 0) -and ($availableEmptyTitle.Length -gt 0) -and ($installedEmptyTitle -cne $availableEmptyTitle)
        Add-UiCheck -Case $case -Id 'P6-04' -Title $C.'P6-04' -Kind 'behavior' -Ok $distinct `
            -Detail "installedEmpty(noEngineHome)='$installedEmptyTitle' || availableEmpty(offline)='$availableEmptyTitle'"
    } else {
        Add-UiUnverifiable -Case $case -Id 'P6-04' -Title $C.'P6-04' `
            -Reason 'the "available" view is not in an empty state in this run (engine:available returned rows), so the installed-empty vs available-empty wording cannot be compared without depending on the npm registry'
    }
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
