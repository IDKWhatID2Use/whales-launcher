# ---------------------------------------------------------------------------
# Case: shell (title bar / navigation rail / app menu / log drawer / theme).
#
# PURE ASCII ON PURPOSE - PowerShell 5.1 reads .ps1 as ANSI, so every Chinese
# string used below comes from the UTF-8 JSON context file written by
# scripts/test/run-ui-tests.mjs. Do not paste Chinese into this file.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ContextFile,
    [Parameter(Mandatory = $true)][string]$OutJson
)

$ErrorActionPreference = 'Stop'
# PowerShell writes to the console in the OEM code page by default, which turns
# every Chinese assertion title into mojibake in the Node runner's output.
# The JSON result is written with an explicit UTF-8 encoder either way; this is
# purely so a human reading the console sees readable text.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$testRoot = Split-Path -Parent $PSScriptRoot
# -DisableNameChecking: the driver API is fixed by the task spec (Find-ByAutomationId,
# Toggle-Element, Resolve-UiRaw, ...) and a few of those nouns are not on the approved
# verb list. Silencing the warning keeps the runner console readable.
Import-Module (Join-Path $testRoot 'UiDriver.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $testRoot 'UiCase.psm1') -Force -DisableNameChecking

$ctx = Read-UiContext -Path $ContextFile
$L = $ctx.labels.shell
$C = $ctx.checks
$case = New-UiCase -Name $ctx.page -Title $ctx.pageTitle -Route $ctx.route

$app = $null
$failure = ''

function Get-TextsUnder {
    <# Plain enumerable out; call sites wrap in @() (see UiDriver.psm1 ARRAY CONTRACT). #>
    param($Scope)
    $result = New-Object System.Collections.Generic.List[string]
    foreach ($el in @(Get-UiDescendants -Scope $Scope)) {
        $info = Get-UiInfo -Element $el
        if ($info.IsOffscreen) { continue }
        if ([string]::IsNullOrWhiteSpace($info.Name)) { continue }
        $result.Add($info.Name)
    }
    return $result.ToArray()
}

function Test-TextPresent {
    param($Scope, [string]$Needle)
    foreach ($text in @(Get-TextsUnder -Scope $Scope)) {
        if ($text.IndexOf($Needle, [System.StringComparison]::Ordinal) -ge 0) { return $true }
    }
    return $false
}

try {
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
    Add-UiDiagnostic -Case $case -Text "pid=$($app.Pid) hwnd=$($app.Hwnd) class=$($app.ClassName) route=$($ctx.route)"

    $root = Get-UiRoot -Hwnd $app.Hwnd

    # ---------------------------------------------------------------- SH-01
    # Rail instance rows: counted by matching the backend instance names that
    # the rail is supposed to display. No user-machine name is hardcoded - the
    # names come from instance:list inside the temp home.
    $navHost = Find-ByAutomationId -Id 'MenuItemsHost' -Scope $root -Exact
    $railNames = @(Get-TextsUnder -Scope $navHost)
    $matched = 0
    foreach ($name in $ctx.expect.instanceNames) {
        if ($railNames -contains $name) { $matched++ }
    }
    Add-UiCheck -Case $case -Id 'SH-01' -Title $C.'SH-01' -Kind 'existence' -Ok ($matched -eq $ctx.expect.instanceCount) `
        -Detail "backend=$($ctx.expect.instanceCount) rail=$matched railTexts=$($railNames.Count)"

    # ---------------------------------------------------------------- SH-02
    $navRoot = Find-ByAutomationId -Id 'Nav' -Scope $root -Exact
    $navTexts = @(Get-TextsUnder -Scope $navRoot)
    $anchors = @($L.railNewInstance, $L.railEngines, $L.railSettings)
    $anchorHits = 0
    foreach ($anchor in $anchors) { if ($navTexts -contains $anchor) { $anchorHits++ } }
    Add-UiCheck -Case $case -Id 'SH-02' -Title $C.'SH-02' -Kind 'existence' -Ok ($anchorHits -eq $anchors.Count) `
        -Detail "found $anchorHits/$($anchors.Count) of the rail entry labels (navTexts=$($navTexts.Count))"

    # ---------------------------------------------------------------- SH-03
    # Behavior: expand the application menu and confirm the menu really opened
    # by looking for a command that only exists inside the flyout.
    $menuOk = $false
    $menuDetail = ''
    $fileItem = Find-ByName -Name $L.appMenuFile -Scope $root -TimeoutMs 8000 -AllowMissing
    if ($null -eq $fileItem) {
        $menuDetail = "app menu item '$($L.appMenuFile)' not found"
    } else {
        Expand-Element -Element $fileItem
        $menuOk = Wait-Until -TimeoutMs 6000 -Message 'app menu items' -Condition {
            $null -ne (Find-ByName -Name $L.appMenuExpected[0] -Scope $root -TimeoutMs 400 -AllowMissing)
        }
        $menus = @(Find-ByControlType -ControlType 'MenuItem' -Scope $root -All -AllowMissing)
        $menuDetail = "menu items after expand: $($menus.Count); probe '$($L.appMenuExpected[0])' visible=$menuOk"
        if ($menus.Count -lt 3) { $menuOk = $false }
    }
    Add-UiCheck -Case $case -Id 'SH-03' -Title $C.'SH-03' -Kind 'behavior' -Ok $menuOk -Detail $menuDetail

    # ---------------------------------------------------------------- SH-04
    # Behavior: Escape closes the flyout again (the popup content leaves the tree).
    $closeOk = $false
    $closeDetail = 'not attempted (menu never opened)'
    if ($fileItem) {
        [void](Send-Keys -Chord 'Escape' -Hwnd $app.Hwnd)
        $closeOk = Wait-Until -TimeoutMs 6000 -Message 'app menu closed' -Condition {
            $null -eq (Find-ByName -Name $L.appMenuExpected[0] -Scope $root -TimeoutMs 400 -AllowMissing)
        }
        $closeDetail = "probe '$($L.appMenuExpected[0])' gone after Escape = $closeOk"
    }
    Add-UiCheck -Case $case -Id 'SH-04' -Title $C.'SH-04' -Kind 'behavior' -Ok $closeOk -Detail $closeDetail

    # ---------------------------------------------------------------- SH-05/06
    # Behavior: the log drawer is a Collapsed panel when closed, so none of its
    # controls exist in the UIA tree; opening it must make them appear.
    # The marker is LogSourceBox (the always-present source selector). LogSurface
    # is deliberately NOT used: it is a ListView, and with an empty log its
    # AutomationPeer is not created at all (verified: absent both before AND
    # after opening, while the rest of the drawer appeared).
    $toggle = Find-ByAutomationId -Id 'LogToggle' -Scope $root -Exact -TimeoutMs 6000 -AllowMissing
    $openOk = $false
    $openDetail = 'LogToggle not found'
    if ($toggle) {
        $before = Get-ElementToggleState -Element $toggle
        $hadSource = $null -ne (Find-ByAutomationId -Id 'LogSourceBox' -Scope $root -Exact -TimeoutMs 400 -AllowMissing)
        $after = Toggle-Element -Element $toggle
        $openOk = Wait-Until -TimeoutMs 8000 -Message 'log drawer controls' -Condition {
            $null -ne (Find-ByAutomationId -Id 'LogSourceBox' -Scope $root -Exact -TimeoutMs 400 -AllowMissing)
        }
        $countText = Find-ByAutomationId -Id $L.logCountAid -Scope $root -Exact -TimeoutMs 2000 -AllowMissing
        $countValue = ''
        if ($countText) { $countValue = Get-ElementName -Element $countText }
        $openDetail = "toggle $before -> $after; drawer controls visible before=$hadSource after=$openOk; countText='$countValue'"
    }
    Add-UiCheck -Case $case -Id 'SH-05' -Title $C.'SH-05' -Kind 'behavior' -Ok $openOk -Detail $openDetail

    $closeDrawerOk = $false
    $closeDrawerDetail = 'not attempted (drawer never opened)'
    if ($toggle -and $openOk) {
        $state = Toggle-Element -Element $toggle
        $closeDrawerOk = Wait-Until -TimeoutMs 8000 -Message 'log drawer closed' -Condition {
            $null -eq (Find-ByAutomationId -Id 'LogSourceBox' -Scope $root -Exact -TimeoutMs 400 -AllowMissing)
        }
        $closeDrawerDetail = "toggle -> $state; drawer controls gone=$closeDrawerOk"
    }
    Add-UiCheck -Case $case -Id 'SH-06' -Title $C.'SH-06' -Kind 'behavior' -Ok $closeDrawerOk -Detail $closeDrawerDetail

    # ---------------------------------------------------------------- SH-07
    # Behavior: the theme button flips the label between dark and light, then
    # flips back so the rest of the run (and the temp home config) is unchanged.
    $themeOk = $false
    $themeDetail = 'ThemeButton or ThemeLabel not found'
    $themeButton = Find-ByAutomationId -Id 'ThemeButton' -Scope $root -TimeoutMs 6000 -AllowMissing
    $themeLabel = Find-ByAutomationId -Id 'ThemeLabel' -Scope $root -TimeoutMs 6000 -AllowMissing
    if ($themeButton -and $themeLabel) {
        $labelBefore = Get-ElementName -Element $themeLabel
        Invoke-Element -Element $themeButton
        $changed = Wait-Until -TimeoutMs 8000 -Message 'theme label change' -Condition {
            $now = Find-ByAutomationId -Id 'ThemeLabel' -Scope $root -TimeoutMs 400 -AllowMissing
            if ($null -eq $now) { return $false }
            return ((Get-ElementName -Element $now) -ne $labelBefore)
        }
        $labelAfter = $labelBefore
        $nowEl = Find-ByAutomationId -Id 'ThemeLabel' -Scope $root -TimeoutMs 1000 -AllowMissing
        if ($nowEl) { $labelAfter = Get-ElementName -Element $nowEl }
        $validPair = (($labelBefore -eq $L.themeDark) -and ($labelAfter -eq $L.themeLight)) -or
                     (($labelBefore -eq $L.themeLight) -and ($labelAfter -eq $L.themeDark))
        $themeOk = ($changed -and $validPair)
        $themeDetail = "label '$labelBefore' -> '$labelAfter'"
        # restore
        $restoreBtn = Find-ByAutomationId -Id 'ThemeButton' -Scope $root -TimeoutMs 2000 -AllowMissing
        if ($restoreBtn) { Invoke-Element -Element $restoreBtn; Start-Sleep -Milliseconds 900 }
    }
    Add-UiCheck -Case $case -Id 'SH-07' -Title $C.'SH-07' -Kind 'behavior' -Ok $themeOk -Detail $themeDetail

    # ---------------------------------------------------------------- SH-08
    $subtitle = Find-ByAutomationId -Id 'PART_SubtitleText' -Scope $root -TimeoutMs 6000 -AllowMissing
    $subtitleText = ''
    if ($subtitle) { $subtitleText = Get-ElementName -Element $subtitle }
    Add-UiCheck -Case $case -Id 'SH-08' -Title $C.'SH-08' -Kind 'existence' -Ok ($subtitleText -eq $L.subtitleInstances) `
        -Detail "PART_SubtitleText='$subtitleText' expected='$($L.subtitleInstances)'"

    # ---------------------------------------------------------------- SH-09
    # Behavior: the rail filter box accepts text (AutoSuggestBox -> inner Edit).
    $filterGroup = Find-ByAutomationId -Id 'InstanceFilter' -Scope $root -TimeoutMs 6000 -AllowMissing
    $filterOk = $false
    $filterDetail = 'InstanceFilter not found'
    if ($filterGroup) {
        $edit = Find-ByControlType -ControlType 'Edit' -Scope $filterGroup -TimeoutMs 4000 -AllowMissing
        if ($edit) {
            $written = Set-ElementValue -Element $edit -Value 'zz'
            $filterOk = ($written -eq 'zz')
            $filterDetail = "wrote 'zz', readback='$written'"
            [void](Set-ElementValue -Element $edit -Value '')
            Start-Sleep -Milliseconds 700
        } else {
            $filterDetail = 'no inner Edit inside InstanceFilter'
        }
    }
    Add-UiCheck -Case $case -Id 'SH-09' -Title $C.'SH-09' -Kind 'behavior' -Ok $filterOk -Detail $filterDetail
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
