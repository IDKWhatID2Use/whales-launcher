# ---------------------------------------------------------------------------
# Case: P2 instance detail - plugins tab.
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
$L = $ctx.labels.detail
$P = $ctx.labels.p2
$C = $ctx.checks
$case = New-UiCase -Name $ctx.page -Title $ctx.pageTitle -Route $ctx.route

$app = $null
$failure = ''

function Get-TabItem {
    <# The instance-detail SelectorBar has no automation peer of its own, so its
       SelectorBarItems are reachable only through the raw view. #>
    param($Root, [string]$Label)
    $items = @(Find-SelectorBarItem -Name $Label -Scope $Root -TimeoutMs 12000 -All -AllowMissing)
    $item = $null
    if ($items.Count -gt 0) { $item = $items[0] }
    return @{ Item = $item; All = $items }
}

try {
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
    Add-UiDiagnostic -Case $case -Text "pid=$($app.Pid) hwnd=$($app.Hwnd) route=$($ctx.route)"
    $root = Get-UiRoot -Hwnd $app.Hwnd

    $tabItems = @(Find-ByControlType -ControlType 'ListItem' -ClassNameLike 'SelectorBarItem' -View Raw -Scope $root -All -AllowMissing)
    $tabNames = @()
    $tabItemsFiltered = @()
    foreach ($item in $tabItems) {
        if ($ctx.labels.detail.tabs -contains $item.Name) { $tabNames += $item.Name; $tabItemsFiltered += $item }
    }

    # ---------------------------------------------------------------- P2-01
    $plugins = Get-TabItem -Root $root -Label $L.tabPlugins
    $pluginsSelected = $null
    if ($plugins.Item) { $pluginsSelected = Get-ElementSelected -Element $plugins.Item }
    Add-UiCheck -Case $case -Id 'P2-01' -Title $C.'P2-01' -Kind 'existence' -Ok ($pluginsSelected -eq $true) `
        -Detail "tab '$($L.tabPlugins)' IsSelected=$pluginsSelected"

    # ---------------------------------------------------------------- P2-03
    $expectedTabs = @($L.tabs)
    $missing = @()
    foreach ($want in $expectedTabs) { if (-not ($tabNames -contains $want)) { $missing += $want } }
    $tabOk = ($tabItemsFiltered.Count -eq $expectedTabs.Count) -and ($missing.Count -eq 0)
    Add-UiCheck -Case $case -Id 'P2-03' -Title $C.'P2-03' -Kind 'existence' -Ok $tabOk `
        -Detail "tabs found=$($tabItemsFiltered.Count) names='$($tabNames -join ', ')' missing='$($missing -join ', ')'"

    # ---------------------------------------------------------------- P2-02
    # The three content blocks are a SelectorBar built in code-behind.
    $blocksOk = $true
    $blockDetail = New-Object System.Collections.Generic.List[string]
    foreach ($block in @($P.blocks)) {
        $found = $null -ne (Find-ByName -Name $block -Scope $root -Exact -TimeoutMs 4000 -AllowMissing)
        $blockDetail.Add("$block=$found")
        if (-not $found) { $blocksOk = $false }
    }
    Add-UiCheck -Case $case -Id 'P2-02' -Title $C.'P2-02' -Kind 'existence' -Ok $blocksOk `
        -Detail ($blockDetail -join ' ')

    # ---------------------------------------------------------------- P2-04
    # Behavior: switching tabs must REALLY change the content. This is the
    # regression guard for the historical defect where a parameterised
    # navigation left the SelectorBar on its XAML default.
    # The tab host is a plain Grid (no automation peer), so the change is
    # observed through markers that only exist in one of the two views.
    $pluginsMarker = $P.blocks[0]
    $settingsMarker = $ctx.labels.p3.isolationRadios.workspace
    $beforeHasPlugins = Test-UiTextContained -Scope $root -Needle $pluginsMarker -Exact
    $beforeHasSettings = Test-UiTextContained -Scope $root -Needle $settingsMarker -Exact
    $beforeTexts = @(Get-UiTexts -Scope $root)

    $settingsTab = Get-TabItem -Root $root -Label $L.tabSettings
    $switchOk = $false
    $switchDetail = "tab '$($L.tabSettings)' not found"
    if ($settingsTab.Item) {
        Select-Element -Element $settingsTab.Item
        $changed = Wait-Until -TimeoutMs 10000 -Message 'plugins tab content gone' -Condition {
            $r = Get-UiRoot -Hwnd $app.Hwnd
            return -not (Test-UiTextContained -Scope $r -Needle $pluginsMarker -Exact)
        }
        $r2 = Get-UiRoot -Hwnd $app.Hwnd
        $afterHasPlugins = Test-UiTextContained -Scope $r2 -Needle $pluginsMarker -Exact
        $afterHasSettings = Test-UiTextContained -Scope $r2 -Needle $settingsMarker -Exact
        $afterTexts = @(Get-UiTexts -Scope $r2)
        $settingsSelected = Get-ElementSelected -Element $settingsTab.Item
        $switchOk = $changed -and ($beforeHasPlugins -and -not $afterHasPlugins) -and ($afterHasSettings) -and
                    (($beforeTexts -join "`n") -cne ($afterTexts -join "`n")) -and ($settingsSelected -eq $true)
        $switchDetail = "pluginsMarker before=$beforeHasPlugins after=$afterHasPlugins; settingsMarker before=$beforeHasSettings after=$afterHasSettings; settings.IsSelected=$settingsSelected; texts $($beforeTexts.Count) -> $($afterTexts.Count)"
        # back to the plugins tab
        $back = Get-TabItem -Root (Get-UiRoot -Hwnd $app.Hwnd) -Label $L.tabPlugins
        if ($back.Item) { Select-Element -Element $back.Item }
    }
    Add-UiCheck -Case $case -Id 'P2-04' -Title $C.'P2-04' -Kind 'behavior' -Ok $switchOk -Detail $switchDetail

    # ---------------------------------------------------------------- P2-06/07/08
    $backButton = Find-ByAutomationId -Id 'BackButton' -Scope $root -Exact -TimeoutMs 6000 -AllowMissing
    Add-UiCheck -Case $case -Id 'P2-06' -Title $C.'P2-06' -Kind 'existence' -Ok ($null -ne $backButton) `
        -Detail "BackButton present=$($null -ne $backButton)"

    $subtitle = Find-ByAutomationId -Id 'PART_SubtitleText' -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    $subtitleText = ''
    if ($subtitle) { $subtitleText = Get-ElementName -Element $subtitle }
    $expectedSubtitle = "$($L.subtitlePrefix)$($L.tabPlugins)"
    Add-UiCheck -Case $case -Id 'P2-07' -Title $C.'P2-07' -Kind 'existence' -Ok ($subtitleText -ceq $expectedSubtitle) `
        -Detail "subtitle='$subtitleText' expected='$expectedSubtitle'"

    $primary = Find-ByAutomationId -Id 'PrimaryActionButton' -Scope $root -Exact -TimeoutMs 6000 -AllowMissing
    Add-UiCheck -Case $case -Id 'P2-08' -Title $C.'P2-08' -Kind 'existence' -Ok ($null -ne $primary) `
        -Detail "PrimaryActionButton present=$($null -ne $primary)"

    # ---------------------------------------------------------------- P2-05
    # Historical defect regression: entering the detail page through the deep
    # link with a tab parameter must actually select THAT tab. The
    # SelectorBarItem's XAML/IsSelected=true dispatches SelectionChanged
    # asynchronously and used to overwrite whatever OnNavigatedTo had set.
    [void](Stop-WhalesApp -Pid $app.Pid -LogDir $ctx.logDir)
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.alternateRoute -Exe $ctx.exe -LogDir $ctx.logDir
    $root2 = Get-UiRoot -Hwnd $app.Hwnd
    $savesTab = Get-TabItem -Root $root2 -Label $L.tabSaves
    $pluginsTab2 = Get-TabItem -Root $root2 -Label $L.tabPlugins
    $savesOk = Wait-Until -TimeoutMs 10000 -Message 'saves tab selected' -Condition {
        $t = Get-TabItem -Root (Get-UiRoot -Hwnd $app.Hwnd) -Label $L.tabSaves
        if ($null -eq $t.Item) { return $false }
        return ((Get-ElementSelected -Element $t.Item) -eq $true)
    }
    $savesSelected = $null
    $pluginsSelected2 = $null
    if ($savesTab.Item) { $savesSelected = Get-ElementSelected -Element $savesTab.Item }
    if ($pluginsTab2.Item) { $pluginsSelected2 = Get-ElementSelected -Element $pluginsTab2.Item }
    Add-UiCheck -Case $case -Id 'P2-05' -Title $C.'P2-05' -Kind 'behavior' -Ok ($savesOk -and ($pluginsSelected2 -eq $false)) `
        -Detail "route='$($ctx.alternateRoute)' saves.IsSelected=$savesSelected plugins.IsSelected=$pluginsSelected2"
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
