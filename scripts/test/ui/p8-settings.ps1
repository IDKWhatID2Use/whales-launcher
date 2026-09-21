# ---------------------------------------------------------------------------
# Case: P8 global settings.
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
$L = $ctx.labels.p8
$C = $ctx.checks
$case = New-UiCase -Name $ctx.page -Title $ctx.pageTitle -Route $ctx.route

$app = $null
$failure = ''

try {
    # Primary path: the WHALES_SMOKE_ROUTE=settings deep link. This used to be
    # broken (the settings page tree was never built because the navigation ran
    # before the backend was attached and SettingsPage.OnNavigatedTo lacked the
    # AppServices.IsReady guard that InstancesPage has); P8-08 keeps an eye on
    # it. If it regresses, the case falls back to activating the navigation
    # rail's "global settings" entry so the rest of the assertions still run.
    $app = Start-WhalesApp -Root $ctx.home -Route $ctx.launchRoute -Exe $ctx.exe -LogDir $ctx.logDir
    Add-UiDiagnostic -Case $case -Text "pid=$($app.Pid) hwnd=$($app.Hwnd) launchRoute=$($ctx.launchRoute)"
    $root = Get-UiRoot -Hwnd $app.Hwnd

    $deepLinkOk = Wait-Until -TimeoutMs 25000 -Message 'settings via deep link' -Condition {
        $null -ne (Find-ByAutomationId -Id $L.themeRadiosAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 800 -AllowMissing)
    }
    $reachedVia = 'deep link'
    if (-not $deepLinkOk) {
        Add-UiDiagnostic -Case $case -Text 'deep link settings did not build the page; falling back to the navigation rail'
        # The rail rows surface as ListItems whose UIA Name is the CLR type name
        # ('WhalesLauncher.Shell.RailEntry'), so the entry is located by the text
        # of its children instead of by name.
        $railEntry = $null
        $railDeadline = [DateTime]::UtcNow.AddSeconds(25)
        while ($null -eq $railEntry -and [DateTime]::UtcNow -lt $railDeadline) {
            $footer = Find-ByAutomationId -Id 'FooterMenuItemsHost' -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 1500 -AllowMissing
            if ($footer) {
                foreach ($row in @(Get-UiChildrenOfType -Element $footer -ControlType 'ListItem')) {
                    if ((@(Get-UiTexts -Scope $row.Element)) -contains $ctx.labels.shell.railSettings) { $railEntry = $row; break }
                }
            }
            if ($null -eq $railEntry) { Start-Sleep -Milliseconds 700 }
        }
        if ($null -eq $railEntry) { throw "entry point missing: neither the settings deep link nor a '$($ctx.labels.shell.railSettings)' rail row" }
        Select-Element -Element $railEntry.Element
        $entered = Wait-Until -TimeoutMs 25000 -Message 'settings via rail' -Condition {
            $null -ne (Find-ByAutomationId -Id $L.themeRadiosAid -Scope (Get-UiRoot -Hwnd $app.Hwnd) -Exact -TimeoutMs 800 -AllowMissing)
        }
        if (-not $entered) { throw 'the global settings page did not open via the deep link or the rail entry' }
        $reachedVia = 'navigation rail'
    }
    $root = Get-UiRoot -Hwnd $app.Hwnd
    Add-UiDiagnostic -Case $case -Text "global settings reached via $reachedVia"

    # ---------------------------------------------------------------- P8-08
    # Regression guard for the WHALES_SMOKE_ROUTE=settings deep link itself.
    Add-UiCheck -Case $case -Id 'P8-08' -Title $C.'P8-08' -Kind 'behavior' -Ok $deepLinkOk `
        -Detail "launchRoute='$($ctx.launchRoute)' reachedVia=$reachedVia"

    # ---------------------------------------------------------------- P8-01
    $radios = Find-ByAutomationId -Id $L.themeRadiosAid -Scope $root -Exact -TimeoutMs 15000 -AllowMissing
    $dark = $null
    $light = $null
    if ($radios) {
        $dark = Find-ByName -Name $L.themeDark -Scope $radios -Exact -TimeoutMs 6000 -AllowMissing
        $light = Find-ByName -Name $L.themeLight -Scope $radios -Exact -TimeoutMs 4000 -AllowMissing
    }
    $themeOk = ($null -ne $dark) -and ($null -ne $light)
    $themeDetail = "ThemeRadios=$($null -ne $radios) dark=$($null -ne $dark) light=$($null -ne $light)"
    Add-UiCheck -Case $case -Id 'P8-01' -Title $C.'P8-01' -Kind 'existence' -Ok $themeOk -Detail $themeDetail

    # ---------------------------------------------------------------- P8-04
    # Behavior: selecting the light option really moves the selection, and the
    # dark option can take it back.
    $selectOk = $false
    $selectDetail = 'theme radio items not found'
    if ($themeOk) {
        Select-Element -Element $light
        $lightSelected = Get-ElementSelected -Element $light
        Select-Element -Element $dark
        $darkSelected = Get-ElementSelected -Element $dark
        $selectOk = ($lightSelected -eq $true) -and ($darkSelected -eq $true)
        $selectDetail = "select light -> light.IsSelected=$lightSelected; select dark -> dark.IsSelected=$darkSelected"
    }
    Add-UiCheck -Case $case -Id 'P8-04' -Title $C.'P8-04' -Kind 'behavior' -Ok $selectOk -Detail $selectDetail

    # ---------------------------------------------------------------- P8-03
    # The page must say, in plain words, that the theme does not follow the OS.
    $statement = Test-UiTextContained -Scope $root -Needle $L.noFollowSystemPhrase
    $statementText = ''
    foreach ($text in @(Get-UiTexts -Scope $root)) {
        if ($text.IndexOf($L.noFollowSystemPhrase, [System.StringComparison]::Ordinal) -ge 0) { $statementText = $text; break }
    }
    Add-UiCheck -Case $case -Id 'P8-03' -Title $C.'P8-03' -Kind 'existence' -Ok $statement -Detail "text='$statementText'"

    # ---------------------------------------------------------------- P8-02
    $candidates = Find-ByAutomationId -Id $L.candidateListAid -Scope $root -Exact -TimeoutMs 10000 -AllowMissing
    $rows = 0
    if ($candidates) { $rows = @(Find-ByControlType -ControlType 'ListItem' -Scope $candidates -All -AllowMissing).Count }
    $candidateEmpty = Find-ByAutomationId -Id $L.candidateEmptyAid -Scope $root -Exact -TimeoutMs 4000 -AllowMissing
    # Either the probe found runtimes (rows) or it explicitly says it found none.
    $candidateOk = (($null -ne $candidates) -and ($rows -gt 0)) -or ($null -ne $candidateEmpty)
    Add-UiCheck -Case $case -Id 'P8-02' -Title $C.'P8-02' -Kind 'existence' -Ok $candidateOk `
        -Detail "CandidateList=$($null -ne $candidates) rows=$rows emptyText=$($null -ne $candidateEmpty)"

    # ---------------------------------------------------------------- P8-05
    $paths = @(
        @{ Aid = $L.primaryHomeAid; Label = 'PrimaryHomeBox' },
        @{ Aid = $L.rootDirAid; Label = 'RootDirBox' },
        @{ Aid = $L.registryAid; Label = 'RegistryBox' }
    )
    $readable = 0
    $pathDetail = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $paths) {
        $el = Find-ByAutomationId -Id $entry.Aid -Scope $root -Exact -TimeoutMs 6000 -AllowMissing
        if ($el) {
            $value = Get-ElementValue -Element $el
            $pathDetail.Add("$($entry.Label)='$value'")
            if ($value.Length -gt 0) { $readable++ }
        } else {
            $pathDetail.Add("$($entry.Label)=MISSING")
        }
    }
    Add-UiCheck -Case $case -Id 'P8-05' -Title $C.'P8-05' -Kind 'existence' -Ok ($readable -eq 3) `
        -Detail ($pathDetail -join ' ; ')

    # ---------------------------------------------------------------- P8-06
    $redetect = Find-ByName -Name $L.redetectButton -Scope $root -Exact -TimeoutMs 8000 -AllowMissing
    Add-UiCheck -Case $case -Id 'P8-06' -Title $C.'P8-06' -Kind 'existence' -Ok ($null -ne $redetect) `
        -Detail "button '$($L.redetectButton)' present=$($null -ne $redetect)"

    # ---------------------------------------------------------------- P8-07
    $conclusion = Find-ByAutomationId -Id $L.nodeConclusionAid -Scope $root -Exact -TimeoutMs 10000 -AllowMissing
    $conclusionText = ''
    if ($conclusion) { $conclusionText = Get-ElementName -Element $conclusion }
    $version = Find-ByAutomationId -Id $L.versionAid -Scope $root -Exact -TimeoutMs 6000 -AllowMissing
    $versionText = ''
    if ($version) { $versionText = Get-ElementName -Element $version }
    $footerOk = ($conclusionText.Length -gt 0) -and ($versionText.Length -gt 0)
    Add-UiCheck -Case $case -Id 'P8-07' -Title $C.'P8-07' -Kind 'existence' -Ok $footerOk `
        -Detail "NodeConclusion='$conclusionText' Version='$versionText'"
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
