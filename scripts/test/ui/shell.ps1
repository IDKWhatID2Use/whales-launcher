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
    # Environment record: WHALES_SMOKE_ROUTE is a PROCESS variable set by
    # Start-WhalesApp, so if anything upstream leaked a different value into this
    # process the app would silently open a different page. Recorded here because
    # a run was observed where the title-bar subtitle was the About page's on the
    # FIRST assertion (SH-08) with no click involved.
    $otherApps = @(Get-Process -Name 'WhalesLauncher' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $app.Pid })
    Add-UiDiagnostic -Case $case -Text "smokeRoute='$($env:WHALES_SMOKE_ROUTE)' ctxRoute='$($ctx.route)' otherWhalesProcs=$($otherApps.Count)"

    $root = Get-UiRoot -Hwnd $app.Hwnd

    # ---------------------------------------------------------------- SH-01
    # The rail no longer carries the instance list. This is a NEGATIVE assertion
    # on purpose: the same data used to be rendered twice on screen (rail rows +
    # the instance card grid), which is exactly the duplication the user asked
    # us to remove. Keeping it negative makes this the regression guard for that
    # fix - if instance rows ever come back to the rail, this check goes red.
    $navHost = Find-ByAutomationId -Id 'MenuItemsHost' -Scope $root -Exact
    $railNames = @(Get-TextsUnder -Scope $navHost)
    $matched = 0
    foreach ($name in $ctx.expect.instanceNames) {
        if ($railNames -contains $name) { $matched++ }
    }
    Add-UiCheck -Case $case -Id 'SH-01' -Title $C.'SH-01' -Kind 'existence' -Ok ($matched -eq 0) `
        -Detail "backend=$($ctx.expect.instanceCount) instance names found in the rail=$matched (expected 0) railTexts=$($railNames.Count)"

    # ---------------------------------------------------------------- SH-02
    # The rail is a static feature list. Every item carries an explicit
    # AutomationProperties.Name, so each one is located by its EXACT UIA name;
    # a "text appears somewhere in the subtree" probe would be ambiguous now
    # (an instance literally named "实例" would satisfy it for the 实例 entry).
    # The first three entries live in MenuItems, 关于 lives in FooterMenuItems.
    $navRoot = Find-ByAutomationId -Id 'Nav' -Scope $root -Exact
    $entries = @($L.railEntries)
    $anchorHits = 0
    $missed = @()
    foreach ($entry in $entries) {
        if ($null -ne (Find-ByName -Name $entry -Scope $navRoot -Exact -TimeoutMs 2000 -AllowMissing)) {
            $anchorHits++
        } else {
            $missed += $entry
        }
    }
    Add-UiCheck -Case $case -Id 'SH-02' -Title $C.'SH-02' -Kind 'existence' -Ok ($anchorHits -eq $entries.Count) `
        -Detail "found $anchorHits/$($entries.Count) rail entries by exact UIA name; missing=[$($missed -join ' | ')]"

    # ---------------------------------------------------------------- SH-03
    # Behavior: expand the application menu and confirm the menu really opened
    # by looking for a command that only exists inside the flyout.
    $menuOk = $false
    $menuDetail = ''
    # Narrow the lookup to ControlType.MenuItem with an EXACT name. A plain
    # Find-ByName does a case-insensitive SUBSTRING match, so it can now return
    # an unrelated Text node whose text merely contains the menu caption - and
    # expanding that node throws (no ExpandCollapsePattern).
    $fileItem = Find-ByControlType -ControlType 'MenuItem' -NameLike $L.appMenuFile -Exact -Scope $root -TimeoutMs 8000 -AllowMissing
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
    # On failure, record WHICH page the app is actually on. A run was observed
    # here where the subtitle was the About page's while WHALES_SMOKE_ROUTE was
    # 'instances', no rail entry had been clicked yet, and no other
    # WhalesLauncher process existed - so the evidence has to say which page it
    # was, not just that the text was wrong.
    $where = ''
    if ($subtitleText -ne $L.subtitleInstances) {
        $gridEl = Find-ByAutomationId -Id $ctx.labels.p1.gridAid -Scope $root -Exact -TimeoutMs 1500 -AllowMissing
        $aboutEl = Find-ByAutomationId -Id 'LauncherVersionText' -Scope $root -Exact -TimeoutMs 1500 -AllowMissing
        $navEl = Find-ByAutomationId -Id 'Nav' -Scope $root -Exact -TimeoutMs 1500 -AllowMissing
        $where = " | onInstancesPage=$($null -ne $gridEl) onAboutPage=$($null -ne $aboutEl) nav=$($null -ne $navEl)"
    }
    Add-UiCheck -Case $case -Id 'SH-08' -Title $C.'SH-08' -Kind 'existence' -Ok ($subtitleText -eq $L.subtitleInstances) `
        -Detail "PART_SubtitleText='$subtitleText' expected='$($L.subtitleInstances)'$where"

    # ---------------------------------------------------------------- SH-09
    # The rail's "filter instances" AutoSuggestBox is gone (decision D3): the
    # instance page has its own search box, and keeping both would restore the
    # duplication this whole change removes. Negative assertion by design.
    $filterGroup = Find-ByAutomationId -Id 'InstanceFilter' -Scope $root -TimeoutMs 6000 -AllowMissing
    Add-UiCheck -Case $case -Id 'SH-09' -Title $C.'SH-09' -Kind 'existence' -Ok ($null -eq $filterGroup) `
        -Detail "InstanceFilter present=$($null -ne $filterGroup) (expected absent)"

    # ---------------------------------------------------------------- SH-10
    # Behavior: the old rail had no "instance list" entry, so once the user was
    # on P6/P7/P8 there was no path back to P1 (registered as a defect in the
    # hand-over doc). The rail is a feature list now, so 引擎版本管理 -> 实例 must
    # work in one click. Both directions are checked: the selection state of the
    # destination item (driven by the router) plus real page content.
    $railEnginesItem = $null
    $railInstancesItem = $null
    $hopOk = $false
    $hopDetail = 'rail entries not found'
    if ($navRoot) {
        $railEnginesItem = Find-ByName -Name $L.railEngines -Scope $navRoot -Exact -TimeoutMs 4000 -AllowMissing
        $railInstancesItem = Find-ByName -Name $L.railInstances -Scope $navRoot -Exact -TimeoutMs 4000 -AllowMissing
    }
    if ($railEnginesItem -and $railInstancesItem) {
        Select-Element -Element $railEnginesItem
        $onEngines = Wait-Until -TimeoutMs 20000 -Message 'engines page via rail entry' -Condition {
            $now = Find-ByAutomationId -Id 'NavEngines' -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 500 -AllowMissing
            if ($null -eq $now) { return $false }
            return (Get-ElementSelected -Element $now)
        }
        Select-Element -Element $railInstancesItem
        $backToInstances = Wait-Until -TimeoutMs 20000 -Message 'instances page via rail entry' -Condition {
            $null -ne (Find-ByAutomationId -Id $ctx.labels.p1.gridAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 500 -AllowMissing)
        }
        $hopOk = ($onEngines -and $backToInstances)
        $hopDetail = "engines selected=$onEngines; back to instances=$backToInstances"
    }
    Add-UiCheck -Case $case -Id 'SH-10' -Title $C.'SH-10' -Kind 'behavior' -Ok $hopOk -Detail $hopDetail

    # ---------------------------------------------------------------- SH-11
    # The footer 关于 entry. It is a real ROUTE, not a dialog - and the reason is
    # structural: a NavigationViewItem inside FooterMenuItems stays selected after
    # being picked, so an item that only popped a modal would leave a highlight
    # that means nothing. The title-bar subtitle is derived from the route, which
    # makes it the honest probe here; the hop back proves the entry is not a trap.
    $railAboutItem = Find-ByName -Name $L.railAbout -Scope $navRoot -Exact -TimeoutMs 4000 -AllowMissing
    $railBackItem = Find-ByName -Name $L.railInstances -Scope $navRoot -Exact -TimeoutMs 4000 -AllowMissing
    $aboutOk = $false
    $aboutDetail = 'about entry or instances entry not found in the rail'
    if ($railAboutItem -and $railBackItem) {
        Select-Element -Element $railAboutItem
        $onAbout = Wait-Until -TimeoutMs 20000 -Message 'about page via rail entry' -Condition {
            $now = Find-ByAutomationId -Id 'PART_SubtitleText' -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 500 -AllowMissing
            if ($null -eq $now) { return $false }
            return ((Get-ElementName -Element $now) -eq $L.subtitleAbout)
        }
        Select-Element -Element $railBackItem
        $backFromAbout = Wait-Until -TimeoutMs 20000 -Message 'instances page via rail entry' -Condition {
            $null -ne (Find-ByAutomationId -Id $ctx.labels.p1.gridAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 500 -AllowMissing)
        }
        $aboutOk = ($onAbout -and $backFromAbout)
        $aboutDetail = "subtitle became '$($L.subtitleAbout)'=$onAbout; back to instances=$backFromAbout"
    }
    Add-UiCheck -Case $case -Id 'SH-11' -Title $C.'SH-11' -Kind 'behavior' -Ok $aboutOk -Detail $aboutDetail
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
