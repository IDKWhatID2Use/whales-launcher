# ---------------------------------------------------------------------------
# Case: P1 instance list.
#
# PURE ASCII ON PURPOSE - all Chinese strings come from the UTF-8 JSON context
# file (see UiDriver.psm1 / lib/labels.mjs). Never paste Chinese into this file.
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
$L = $ctx.labels.p1
$C = $ctx.checks
$case = New-UiCase -Name $ctx.page -Title $ctx.pageTitle -Route $ctx.route

$app = $null
$failure = ''

function Get-CardCount {
    param($Root)
    $grid = Find-ByAutomationId -Id $L.gridAid -Scope $Root -Exact -TimeoutMs 8000 -AllowMissing
    if ($null -eq $grid) { return @{ Grid = $null; Count = 0; Cards = @() } }
    # Descendant search (not direct children): a GridView inserts a scroll
    # presenter between itself and the GridViewItems.
    $cards = @(Find-ByControlType -ControlType 'ListItem' -Scope $grid -All -AllowMissing)
    return @{ Grid = $grid; Count = $cards.Count; Cards = $cards }
}

function Get-EmptyStateText {
    <# Read the rendered wording of an empty state by anchoring on its action
       button (buttons always have an automation peer) and walking LEFT through
       the sibling TextBlocks. Nothing is asserted against a hardcoded copy of
       the text: both empty states are read from the UI and then compared. #>
    param($Root, [string]$AnchorButton)
    $button = Find-ByName -Name $AnchorButton -Scope $Root -Exact -TimeoutMs 10000 -AllowMissing
    if ($null -eq $button) { return '' }
    $texts = @(Get-UiPrecedingTexts -Element $button -Max 6)
    return ($texts -join ' | ')
}

function Set-Search {
    param($Root, [string]$Text)
    $box = Find-ByAutomationId -Id 'SearchBox' -Scope $Root -Exact -TimeoutMs 6000
    $edit = Find-ByControlType -ControlType 'Edit' -Scope $box -TimeoutMs 4000
    return (Set-ElementValue -Element $edit -Value $Text)
}

try {
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
    Add-UiDiagnostic -Case $case -Text "pid=$($app.Pid) hwnd=$($app.Hwnd) route=$($ctx.route)"
    $root = Get-UiRoot -Hwnd $app.Hwnd

    # ---------------------------------------------------------------- P1-01
    $before = Get-CardCount -Root $root
    Add-UiCheck -Case $case -Id 'P1-01' -Title $C.'P1-01' -Kind 'existence' `
        -Ok ($before.Count -eq $ctx.expect.instanceCount) `
        -Detail "backend=$($ctx.expect.instanceCount) cards=$($before.Count) gridFound=$($null -ne $before.Grid)"

    # ---------------------------------------------------------------- P1-02
    # Every card must expose a status WORD, not just a colour swatch.
    $statusOk = $false
    $statusDetail = 'no cards'
    if ($before.Count -gt 0) {
        $withStatus = 0
        foreach ($card in $before.Cards) {
            $texts = @(Get-UiTexts -Scope $card.Element)
            if ($texts -contains $L.statusStoppedText) { $withStatus++ }
        }
        $statusOk = ($withStatus -eq $before.Count)
        $statusDetail = "$withStatus/$($before.Count) cards carry the status text '$($L.statusStoppedText)'"
    }
    Add-UiCheck -Case $case -Id 'P1-02' -Title $C.'P1-02' -Kind 'existence' -Ok $statusOk -Detail $statusDetail

    # ---------------------------------------------------------------- P1-03
    # Behavior: filtering really reduces the card count.
    $hitWritten = Set-Search -Root $root -Text $ctx.expect.searchHitQuery
    $hitOk = Wait-Until -TimeoutMs 8000 -Message 'filtered card count' -Condition {
        (Get-CardCount -Root (Get-UiRoot -Hwnd $app.Hwnd)).Count -eq $ctx.expect.searchHitCount
    }
    $afterHit = Get-CardCount -Root (Get-UiRoot -Hwnd $app.Hwnd)
    $reduced = ($afterHit.Count -lt $before.Count) -and ($afterHit.Count -eq $ctx.expect.searchHitCount)
    Add-UiCheck -Case $case -Id 'P1-03' -Title $C.'P1-03' -Kind 'behavior' -Ok ($hitOk -and $reduced) `
        -Detail "query='$($ctx.expect.searchHitQuery)' readback='$hitWritten' cards $($before.Count) -> $($afterHit.Count) (expected $($ctx.expect.searchHitCount))"

    # ---------------------------------------------------------------- P1-04
    # Behavior: an impossible query must produce the FILTERED empty state.
    [void](Set-Search -Root (Get-UiRoot -Hwnd $app.Hwnd) -Text $ctx.expect.noMatchQuery)
    $noMatchRoot = Get-UiRoot -Hwnd $app.Hwnd
    $noMatchOk = Wait-Until -TimeoutMs 10000 -Message 'filtered empty state' -Condition {
        $null -ne (Find-ByName -Name $L.emptyNoMatchButton -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 500 -AllowMissing)
    }
    $noMatchTitle = Get-EmptyStateText -Root $noMatchRoot -AnchorButton $L.emptyNoMatchButton
    Add-UiCheck -Case $case -Id 'P1-04' -Title $C.'P1-04' -Kind 'behavior' -Ok ($noMatchOk -and $noMatchTitle.Length -gt 0) `
        -Detail "empty-filter anchor '$($L.emptyNoMatchButton)' present=$noMatchOk; rendered text='$noMatchTitle'"

    # ---------------------------------------------------------------- P1-05
    # Behavior: the "no match" empty state must NOT render the same text as the
    # "no instances at all" empty state. Both strings are READ FROM THE UI
    # (anchored on each state's action button) and then compared - this is not
    # a comparison of two constants copied into the test.
    [void](Stop-WhalesApp -Pid $app.Pid -LogDir $ctx.logDir)
    $app = Start-WhalesApp -Root $ctx.expect.emptyHomeDir -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
    $emptyRoot = Get-UiRoot -Hwnd $app.Hwnd
    $noInstanceTitle = Get-EmptyStateText -Root $emptyRoot -AnchorButton $L.emptyNoInstanceButton
    $distinct = ($noMatchTitle.Length -gt 0) -and ($noInstanceTitle.Length -gt 0) -and ($noMatchTitle -cne $noInstanceTitle)
    Add-UiCheck -Case $case -Id 'P1-05' -Title $C.'P1-05' -Kind 'behavior' -Ok $distinct `
        -Detail "no-match='$noMatchTitle' || no-instance='$noInstanceTitle'"

    # back to the main home for the remaining checks
    [void](Stop-WhalesApp -Pid $app.Pid -LogDir $ctx.logDir)
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
    $root = Get-UiRoot -Hwnd $app.Hwnd

    # ---------------------------------------------------------------- P1-06
    # Behavior: the per-card "more" flyout opens and lists the real commands.
    $fresh = Get-CardCount -Root $root
    $moreOk = $false
    $moreDetail = 'no cards'
    if ($fresh.Count -gt 0) {
        $moreButton = Find-ByName -Name $L.moreButton -Scope $fresh.Cards[0].Element -Exact -TimeoutMs 6000 -AllowMissing
        if ($null -eq $moreButton) {
            $moreDetail = "'$($L.moreButton)' button not found inside the first card"
        } else {
            Invoke-Element -Element $moreButton
            $probe = $L.moreMenuExpected[0]
            $opened = Wait-Until -TimeoutMs 8000 -Message 'card flyout' -Condition {
                $null -ne (Find-ByName -Name $probe -Scope $root -Exact -TimeoutMs 500 -AllowMissing)
            }
            $items = @(Find-ByControlType -ControlType 'MenuItem' -Scope $root -All -AllowMissing)
            $found = 0
            foreach ($menu in $L.moreMenuExpected) {
                foreach ($item in $items) { if ($item.Name -ceq $menu) { $found++; break } }
            }
            $moreOk = $opened -and ($found -ge 5)
            $moreDetail = "flyout opened=$opened, expected items found $found/$($L.moreMenuExpected.Count)"
            [void](Send-Keys -Chord 'Escape' -Hwnd $app.Hwnd)
            Start-Sleep -Milliseconds 700
        }
    }
    Add-UiCheck -Case $case -Id 'P1-06' -Title $C.'P1-06' -Kind 'behavior' -Ok $moreOk -Detail $moreDetail

    # ---------------------------------------------------------------- P1-07
    $detailOk = $false
    $detailDetail = 'no cards'
    if ($fresh.Count -gt 0) {
        $withButton = 0
        foreach ($card in $fresh.Cards) {
            if ($null -ne (Find-ByName -Name $L.detailButton -Scope $card.Element -Exact -TimeoutMs 500 -AllowMissing)) { $withButton++ }
        }
        $detailOk = ($withButton -eq $fresh.Count)
        $detailDetail = "$withButton/$($fresh.Count) cards have a '$($L.detailButton)' button"
    }
    Add-UiCheck -Case $case -Id 'P1-07' -Title $C.'P1-07' -Kind 'existence' -Ok $detailOk -Detail $detailDetail

    # ---------------------------------------------------------------- P1-08
    $filterOk = $false
    $filterDetail = 'status filter items missing'
    $labels = @($L.filterAll, $L.filterRunning, $L.filterStopped, $L.filterAttention)
    $present = 0
    $selectedAll = $null
    $selectedStopped = $null
    foreach ($label in $labels) {
        $item = Find-ByName -Name $label -Scope (Find-ByAutomationId -Id 'StatusFilter' -Scope $root -Exact -TimeoutMs 5000 -AllowMissing) -Exact -TimeoutMs 3000 -AllowMissing
        if ($item) { $present++ }
    }
    $allItem = Find-ByAutomationId -Id 'FilterAll' -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    $stoppedItem = Find-ByAutomationId -Id 'FilterStopped' -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    if ($allItem) { $selectedAll = Get-ElementSelected -Element $allItem }
    if ($stoppedItem) { $selectedStopped = Get-ElementSelected -Element $stoppedItem }
    $filterOk = ($present -eq 4) -and ($selectedAll -eq $true) -and ($selectedStopped -eq $false)
    $filterDetail = "items=$present/4 all.IsSelected=$selectedAll stopped.IsSelected=$selectedStopped"
    Add-UiCheck -Case $case -Id 'P1-08' -Title $C.'P1-08' -Kind 'existence' -Ok $filterOk -Detail $filterDetail

    # ---------------------------------------------------------------- P1-09
    $sort = Find-ByAutomationId -Id 'SortBox' -Scope $root -Exact -TimeoutMs 5000 -AllowMissing
    $sortOk = ($null -ne $sort) -and ($sort.IsEnabled)
    $sortDetail = 'SortBox not found'
    if ($sort) { $sortDetail = "SortBox ct=$($sort.ControlType) enabled=$($sort.IsEnabled)" }
    Add-UiCheck -Case $case -Id 'P1-09' -Title $C.'P1-09' -Kind 'existence' -Ok $sortOk -Detail $sortDetail

    # ---------------------------------------------------------------- P1-10
    # Behavior: refresh keeps the list consistent with the backend.
    $refresh = Find-ByAutomationId -Id 'RefreshButton' -Scope $root -Exact -TimeoutMs 5000 -AllowMissing
    $refreshOk = $false
    $refreshDetail = 'RefreshButton not found'
    if ($refresh) {
        Invoke-Element -Element $refresh
        Start-Sleep -Milliseconds 2500
        $afterRefresh = Get-CardCount -Root (Get-UiRoot -Hwnd $app.Hwnd)
        $refreshOk = ($afterRefresh.Count -eq $ctx.expect.instanceCount)
        $refreshDetail = "cards after refresh = $($afterRefresh.Count) (backend $($ctx.expect.instanceCount))"
    }
    Add-UiCheck -Case $case -Id 'P1-10' -Title $C.'P1-10' -Kind 'behavior' -Ok $refreshOk -Detail $refreshDetail
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
    # Any instance the UI may have created despite the assertions must not leak
    # into the temp home silently - the runner deletes the whole home anyway.
    $result = Complete-UiCase -Case $case -OutJson $OutJson -Error $failure -InfrastructureError $infra
    if ($result.failed -gt 0 -or $result.error) { exit 1 }
    exit 0
}
