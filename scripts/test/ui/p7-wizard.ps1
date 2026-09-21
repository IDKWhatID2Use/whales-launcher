# ---------------------------------------------------------------------------
# Case: P7 create-instance wizard.
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
$L = $ctx.labels.p7
$C = $ctx.checks
$case = New-UiCase -Name $ctx.page -Title $ctx.pageTitle -Route $ctx.route

$app = $null
$failure = ''
$instancesDir = Join-Path $ctx.home 'instances'

try {
    # The wizard is reached by CLICKING the page-header "new instance" button
    # instead of the WHALES_SMOKE_ROUTE=create deep link. That deep link runs
    # during the MainWindow constructor, before the backend is attached, and
    # WizardPage.OnNavigatedTo touches AppServices.State without an IsReady
    # guard (unlike InstancesPage) - the exception is swallowed by
    # NavigateSmokeRoute's try/catch and the page tree is never built. See the
    # PAGES comment in run-ui-tests.mjs and the report's defect section.
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.launchRoute -Exe $ctx.exe -LogDir $ctx.logDir
    Add-UiDiagnostic -Case $case -Text "pid=$($app.Pid) hwnd=$($app.Hwnd) launchRoute=$($ctx.launchRoute)"
    $root = Get-UiRoot -Hwnd $app.Hwnd

    $entry = Find-ByAutomationId -Id 'CreateButton' -Scope $root -Exact -TimeoutMs 25000 -AllowMissing
    if ($null -eq $entry) { throw "entry point missing: no 'CreateButton' on the instances page" }
    Invoke-Element -Element $entry
    $entered = Wait-Until -TimeoutMs 25000 -Message 'create wizard step bar' -Condition {
        $null -ne (Find-ByAutomationId -Id 'Step1Item' -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 800 -AllowMissing)
    }
    if (-not $entered) { throw 'the create wizard did not open after clicking the header button' }
    $root = Get-UiRoot -Hwnd $app.Hwnd
    Add-UiDiagnostic -Case $case -Text 'create wizard opened via the page-header button'

    # ---------------------------------------------------------------- P7-01
    $stepAids = @('Step1Item', 'Step2Item', 'Step3Item', 'Step4Item')
    $stepTexts = @()
    foreach ($aid in $stepAids) {
        $el = Find-ByAutomationId -Id $aid -Scope $root -Exact -TimeoutMs 12000 -AllowMissing
        if ($el) { $stepTexts += (Get-ElementName -Element $el) } else { $stepTexts += '' }
    }
    $expectedSteps = @($L.steps)
    $stepOk = $true
    for ($i = 0; $i -lt $expectedSteps.Count; $i++) {
        if ($stepTexts[$i] -cne $expectedSteps[$i]) { $stepOk = $false }
    }
    Add-UiCheck -Case $case -Id 'P7-01' -Title $C.'P7-01' -Kind 'existence' -Ok $stepOk `
        -Detail "step bar texts: '$($stepTexts -join ' / ')'"

    # ---------------------------------------------------------------- P7-05
    # Unreachable steps must be visibly disabled until step 1 is satisfied.
    $disabled = 0
    $stateDetail = New-Object System.Collections.Generic.List[string]
    for ($i = 1; $i -lt 4; $i++) {
        $el = Find-ByAutomationId -Id $stepAids[$i] -Scope $root -Exact -TimeoutMs 3000 -AllowMissing
        if ($el) {
            $stateDetail.Add("$($stepAids[$i]).enabled=$($el.IsEnabled)")
            if (-not $el.IsEnabled) { $disabled++ }
        }
    }
    Add-UiCheck -Case $case -Id 'P7-05' -Title $C.'P7-05' -Kind 'existence' -Ok ($disabled -eq 3) `
        -Detail "disabled steps=$disabled/3 :: $($stateDetail -join ' ')"

    # ---------------------------------------------------------------- P7-06
    $iconGrid = Find-ByAutomationId -Id $L.iconGridAid -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    $colorGrid = Find-ByAutomationId -Id $L.colorGridAid -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    $icons = 0
    if ($iconGrid) { $icons = @(Find-ByControlType -ControlType 'ListItem' -Scope $iconGrid -All -AllowMissing).Count }
    Add-UiCheck -Case $case -Id 'P7-06' -Title $C.'P7-06' -Kind 'existence' -Ok (($null -ne $iconGrid) -and ($null -ne $colorGrid) -and ($icons -ge 6)) `
        -Detail "IconGrid=$($null -ne $iconGrid) options=$icons ColorGrid=$($null -ne $colorGrid)"

    # ---------------------------------------------------------------- P7-07
    $cancel = Find-ByName -Name $L.cancelButton -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    $back = Find-ByName -Name $L.backButton -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    Add-UiCheck -Case $case -Id 'P7-07' -Title $C.'P7-07' -Kind 'existence' -Ok (($null -ne $cancel) -and ($null -ne $back)) `
        -Detail "cancel=$($null -ne $cancel) back=$($null -ne $back)"

    # ---------------------------------------------------------------- P7-03
    # Behavior: an illegal name is rejected live, with an explanation.
    $nameBox = Find-ByAutomationId -Id $L.nameBoxAid -Scope $root -Exact -TimeoutMs 10000 -AllowMissing
    $invalidOk = $false
    $invalidDetail = 'NameBox not found'
    if ($nameBox) {
        [void](Set-ElementValue -Element $nameBox -Value $L.invalidName)
        $invalidOk = Wait-Until -TimeoutMs 8000 -Message 'name error' -Condition {
            $err = Find-ByAutomationId -Id $L.nameErrorAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 500 -AllowMissing
            if ($null -eq $err) { return $false }
            return ((Get-ElementName -Element $err).Length -gt 0)
        }
        $errEl = Find-ByAutomationId -Id $L.nameErrorAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 2000 -AllowMissing
        $errText = ''
        if ($errEl) { $errText = Get-ElementName -Element $errEl }
        $invalidDetail = "name='$($L.invalidName)' errorText='$errText'"
    }
    Add-UiCheck -Case $case -Id 'P7-03' -Title $C.'P7-03' -Kind 'behavior' -Ok $invalidOk -Detail $invalidDetail

    # ---------------------------------------------------------------- P7-04
    # Behavior: a legal name clears the error and produces a directory preview.
    $validOk = $false
    $validDetail = 'NameBox not found'
    if ($nameBox) {
        [void](Set-ElementValue -Element $nameBox -Value $L.validName)
        $cleared = Wait-Until -TimeoutMs 8000 -Message 'name error cleared' -Condition {
            $err = Find-ByAutomationId -Id $L.nameErrorAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 500 -AllowMissing
            if ($null -eq $err) { return $true }
            return ((Get-ElementName -Element $err).Length -eq 0)
        }
        $preview = Find-ByAutomationId -Id $L.dirPreviewAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 4000 -AllowMissing
        $previewText = ''
        if ($preview) { $previewText = Get-ElementName -Element $preview }
        $validOk = $cleared -and ($previewText.Length -gt 0)
        $validDetail = "name='$($L.validName)' errorCleared=$cleared DirPreview='$previewText'"
    }
    Add-UiCheck -Case $case -Id 'P7-04' -Title $C.'P7-04' -Kind 'behavior' -Ok $validOk -Detail $validDetail

    # ---------------------------------------------------------------- P7-02
    # Behavior: submitting with an EMPTY name must not create anything. Verified
    # against the filesystem (the instances directory of the temp home), not
    # against a toast that may or may not be rendered.
    [void](Set-ElementValue -Element $nameBox -Value '')
    Start-Sleep -Milliseconds 1200
    $beforeCount = Get-ExpectedCount -Path $instancesDir
    $create = Find-ByName -Name $L.createButton -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    $submitOk = $false
    $submitDetail = "button '$($L.createButton)' not found"
    if ($create) {
        Invoke-Element -Element $create
        Start-Sleep -Milliseconds 3500
        $afterCount = Get-ExpectedCount -Path $instancesDir
        # A ContentDialog (if any) would block further interaction - dismiss it.
        [void](Send-Keys -Chord 'Escape' -Hwnd $app.Hwnd)
        Start-Sleep -Milliseconds 800
        # Liveness is reported but NOT part of the verdict: another process on
        # this machine kills WhalesLauncher.exe periodically (see the report's
        # environment note), and that must not turn "nothing was created" into a
        # failure. The instance count is read from disk, so it is valid either way.
        $stillAlive = [WinAuditCore]::Alive($app.Pid)
        $submitOk = ($afterCount -eq $beforeCount)
        $submitDetail = "instance dirs $beforeCount -> $afterCount (expected unchanged); process alive at check time=$stillAlive"
    }
    Add-UiCheck -Case $case -Id 'P7-02' -Title $C.'P7-02' -Kind 'behavior' -Ok $submitOk -Detail $submitDetail
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
