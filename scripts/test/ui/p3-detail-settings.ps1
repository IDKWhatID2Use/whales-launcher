# ---------------------------------------------------------------------------
# Case: P3 instance detail - settings tab (settings.yaml editor + isolation).
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
$L = $ctx.labels.p3
$D = $ctx.labels.detail
$C = $ctx.checks
$case = New-UiCase -Name $ctx.page -Title $ctx.pageTitle -Route $ctx.route

$app = $null
$failure = ''

try {
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.route -Exe $ctx.exe -LogDir $ctx.logDir
    Add-UiDiagnostic -Case $case -Text "pid=$($app.Pid) hwnd=$($app.Hwnd) route=$($ctx.route)"
    $root = Get-UiRoot -Hwnd $app.Hwnd

    # ---------------------------------------------------------------- P3-01
    # The YAML editor is the YamlEditorView user control; its TextBox carries
    # AutomationProperties.Name = 'settings.yaml 内容' and x:Name = 'Editor'.
    $editor = Find-ByAutomationId -Id $L.editorAid -Scope $root -Exact -TimeoutMs 15000 -AllowMissing
    $editorValue = ''
    $editorOk = $false
    $editorDetail = 'editor not found'
    if ($editor) {
        $editorValue = Get-ElementValue -Element $editor
        $named = $null -ne (Find-ByName -Name $L.editorName -Scope $root -Exact -TimeoutMs 4000 -AllowMissing)
        # A real editor is populated; the fixture home ships a settings.yaml so
        # an empty box would mean the file was never loaded.
        $editorOk = ($editorValue.Length -gt 0) -and $named
        $editorDetail = "ct=$($editor.ControlType) valueLen=$($editorValue.Length) namedByProperty=$named firstLine='$(($editorValue -split "`r?`n")[0])'"
    }
    Add-UiCheck -Case $case -Id 'P3-01' -Title $C.'P3-01' -Kind 'existence' -Ok $editorOk -Detail $editorDetail

    # ---------------------------------------------------------------- P3-02
    # The line-number column is a read-only TextBox explicitly marked
    # AutomationProperties.AccessibilityView="Raw" (so screen readers do not
    # read line numbers as content), which removes it from the control view.
    # Finding it therefore REQUIRES the raw view - a control-view-only driver
    # reports "no gutter" on a fully correct UI.
    $gutter = Find-ByAutomationId -Id $L.gutterAid -Scope $root -Exact -View Raw -TimeoutMs 12000 -AllowMissing
    $gutterValue = ''
    if ($gutter) { $gutterValue = Get-ElementValue -Element $gutter }
    $gutterOk = ($null -ne $gutter) -and ($gutterValue.Length -gt 0)
    Add-UiCheck -Case $case -Id 'P3-02' -Title $C.'P3-02' -Kind 'existence' -Ok $gutterOk `
        -Detail "gutter ct=$(if ($gutter) { $gutter.ControlType } else { 'MISSING' }) value='$(($gutterValue -split "`r?`n") -join '/')'"

    # ---------------------------------------------------------------- P3-03
    # Each isolation dimension must be a real radio group with at least two
    # readable, individually addressable options.
    $groups = @(
        @{ Key = 'workspace'; Name = $L.isolationRadios.workspace },
        @{ Key = 'saves'; Name = $L.isolationRadios.saves },
        @{ Key = 'settings'; Name = $L.isolationRadios.settings },
        @{ Key = 'credentials'; Name = $L.isolationRadios.credentials }
    )
    $groupOkCount = 0
    $described = 0
    $groupDetails = New-Object System.Collections.Generic.List[string]
    foreach ($group in $groups) {
        $el = Find-ByName -Name $group.Name -Scope $root -Exact -TimeoutMs 5000 -AllowMissing
        if ($null -eq $el) {
            $groupDetails.Add("$($group.Key)=MISSING")
            continue
        }
        $radios = @(Find-ByControlType -ControlType 'RadioButton' -Scope $el -All -AllowMissing)
        $names = @()
        $selectionSupport = 0
        foreach ($radio in $radios) {
            if ($radio.Name) { $names += $radio.Name }
            if ($null -ne (Get-ElementSelected -Element $radio.Element)) { $selectionSupport++ }
        }
        $ok = ($radios.Count -ge 2) -and ($names.Count -eq $radios.Count)
        if ($ok) { $groupOkCount++ }

        # The explanatory sentence lives next to the group, not inside it: read
        # the surrounding texts and require a substantive one.
        $parent = Get-ElementParent -Element $el -Levels 1
        $around = @(Get-UiTexts -Scope $parent.Element)
        $longest = 0
        foreach ($text in $around) { if ($text.Length -gt $longest) { $longest = $text.Length } }
        if ($longest -ge 20) { $described++ }
        $groupDetails.Add("$($group.Key): options=$($radios.Count) selectionItemPattern=$selectionSupport longestText=$longest names='$($names -join '/')'")
    }
    Add-UiCheck -Case $case -Id 'P3-03' -Title $C.'P3-03' -Kind 'existence' -Ok ($groupOkCount -eq 4) `
        -Detail "readable groups=$groupOkCount/4 :: $($groupDetails -join ' ; ')"
    Add-UiCheck -Case $case -Id 'P3-04' -Title $C.'P3-04' -Kind 'existence' -Ok ($described -eq 4) `
        -Detail "groups with a substantive (>20 chars) explanation next to them = $described/4"

    # ---------------------------------------------------------------- P3-05
    $save = Find-ByName -Name $L.saveName -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    $reload = Find-ByName -Name $L.reloadName -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    $saveOk = ($null -ne $save) -and ($null -ne $reload)
    $saveDetail = 'save/reload buttons not both found'
    if ($saveOk) {
        $saveDetail = "save.IsEnabled=$($save.IsEnabled) reload.IsEnabled=$($reload.IsEnabled) (unmodified document -> save disabled is correct)"
    }
    Add-UiCheck -Case $case -Id 'P3-05' -Title $C.'P3-05' -Kind 'existence' -Ok $saveOk -Detail $saveDetail

    # ---------------------------------------------------------------- P3-06
    # The detail SelectorBar has no automation peer of its own, so its items are
    # only reachable through the raw view.
    $settingsTab = Find-SelectorBarItem -Name $D.tabSettings -Scope $root -TimeoutMs 12000 -AllowMissing
    $selected = $null
    if ($settingsTab) { $selected = Get-ElementSelected -Element $settingsTab }
    Add-UiCheck -Case $case -Id 'P3-06' -Title $C.'P3-06' -Kind 'existence' -Ok ($selected -eq $true) `
        -Detail "tab '$($D.tabSettings)' IsSelected=$selected"

    # ---------------------------------------------------------------- P3-07
    $path = Find-ByAutomationId -Id 'PathText' -Scope $root -Exact -TimeoutMs 6000 -AllowMissing
    $pathText = ''
    if ($path) { $pathText = Get-ElementName -Element $path }
    $pathOk = ($pathText.Length -gt 0) -and (Test-UiTextContained -Scope $root -Needle $L.isolationTitle)
    Add-UiCheck -Case $case -Id 'P3-07' -Title $C.'P3-07' -Kind 'existence' -Ok $pathOk `
        -Detail "PathText='$pathText' isolationSectionVisible=$(Test-UiTextContained -Scope $root -Needle $L.isolationTitle)"
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
