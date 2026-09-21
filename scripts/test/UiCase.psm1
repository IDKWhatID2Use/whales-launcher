# ---------------------------------------------------------------------------
# UiCase.psm1 - assertion + result harness for the per-page UI test cases.
#
# Split out of UiDriver.psm1 on purpose: the driver knows how to talk to UI
# Automation, the case harness knows how to report. Keeping them apart means a
# failure in the reporting layer can never be mistaken for a UI defect.
#
# PURE ASCII ON PURPOSE - PowerShell 5.1 reads .ps1/.psm1 as ANSI, so every
# human-readable Chinese string is supplied by the caller from the UTF-8 JSON
# context file (see UiDriver.psm1#Read-UiContext).
#
# HONESTY RULE
#   A check is one of pass / fail / unverifiable. "unverifiable" exists so that
#   something this harness cannot actually observe is never silently counted as
#   a pass; the runner reports the three counts separately.
# ---------------------------------------------------------------------------

Set-StrictMode -Version 2.0

function New-UiCase {
    <#
    .SYNOPSIS
        Create the result accumulator for one page case.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Title,
        [string]$Route = ''
    )
    return [pscustomobject]@{
        Name        = $Name
        Title       = $Title
        Route       = $Route
        Checks      = (New-Object System.Collections.Generic.List[object])
        Diagnostics = (New-Object System.Collections.Generic.List[string])
        StartedAt   = (Get-Date).ToUniversalTime().ToString('o')
        StartedUtc  = [DateTime]::UtcNow
        Error       = $null
    }
}

function Add-UiCheck {
    <#
    .SYNOPSIS
        Record one assertion outcome.
    .PARAMETER Kind
        existence  - the control / text is present
        behavior   - the UI reacted to an interaction (the assertions that
                     actually catch regressions, e.g. "the tab content changed")
        pixel      - derived from a captured PNG
        smoke      - process-level liveness
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Case,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [string]$Kind = 'existence',
        [string]$Detail = ''
    )
    $status = 'fail'
    if ($Ok) { $status = 'pass' }
    $entry = [pscustomobject]@{
        Id     = $Id
        Title  = $Title
        Kind   = $Kind
        Status = $status
        Detail = $Detail
    }
    $Case.Checks.Add($entry)
    $mark = 'FAIL'
    if ($Ok) { $mark = 'ok' }
    Write-Host ("    [{0}] {1} {2}" -f $mark, $Id, $Title)
    if ($Detail) { Write-Host ("           {0}" -f $Detail) }
    # Intentionally emits nothing: PowerShell would otherwise print the returned
    # object after every call and bury the actual output.
}

function Add-UiAssert {
    <#
    .SYNOPSIS
        Evaluate a condition script block and record it as pass/fail.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Case,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [string]$Kind = 'existence',
        [string]$Detail = ''
    )
    $ok = $false
    $extra = ''
    try {
        $ok = [bool](& $Condition)
    } catch {
        $ok = $false
        $extra = "exception: $($_.Exception.Message)"
        $Case.Diagnostics.Add("[$Id] $extra")
    }
    $text = $Detail
    if ($extra) {
        if ($text) { $text = "$text | $extra" } else { $text = $extra }
    }
    Add-UiCheck -Case $Case -Id $Id -Title $Title -Ok $ok -Kind $Kind -Detail $text
}

function Add-UiUnverifiable {
    <#
    .SYNOPSIS
        Record something the harness deliberately does not claim to verify.
    .DESCRIPTION
        Never counts toward the pass total. Use it for anything that cannot be
        observed through UI Automation / PrintWindow on this machine (for
        example: a runtime behaviour that needs a real dsh engine install, or a
        property with no UIA representation at all).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Case,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Reason,
        [string]$Kind = 'unverifiable'
    )
    $entry = [pscustomobject]@{
        Id     = $Id
        Title  = $Title
        Kind   = $Kind
        Status = 'unverifiable'
        Detail = $Reason
    }
    $Case.Checks.Add($entry)
    Write-Host ("    [ ?? ] {0} {1}" -f $Id, $Title)
    Write-Host ("           unverifiable: {0}" -f $Reason)
}

function Add-UiDiagnostic {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Case,
        [Parameter(Mandatory = $true)][string]$Text
    )
    $Case.Diagnostics.Add($Text)
    Write-Host ("    [diag] {0}" -f $Text)
}

function Complete-UiCase {
    <#
    .SYNOPSIS
        Serialise the case result to JSON (UTF-8, no BOM) and return it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Case,
        [Parameter(Mandatory = $true)][string]$OutJson,
        [string]$Error = '',
        # Set when the failure was NOT produced by the product under test (for
        # example the application process was killed by something else on the
        # machine). The runner retries those instead of reporting a UI defect.
        [string]$InfrastructureError = ''
    )
    if ($Error) { $Case.Error = $Error }
    if ($InfrastructureError) {
        $Case.Error = $InfrastructureError
        $Case.Diagnostics.Add($InfrastructureError)
    }
    $durationMs = [int][math]::Round(([DateTime]::UtcNow - $Case.StartedUtc).TotalMilliseconds)
    $pass = 0; $fail = 0; $unverifiable = 0
    foreach ($c in $Case.Checks) {
        switch ($c.Status) {
            'pass' { $pass++ }
            'fail' { $fail++ }
            'unverifiable' { $unverifiable++ }
        }
    }
    $result = [pscustomobject]@{
        page         = $Case.Name
        title        = $Case.Title
        route        = $Case.Route
        startedAt    = $Case.StartedAt
        durationMs   = $durationMs
        error        = $Case.Error
        infrastructure = [bool]($InfrastructureError -ne '')
        total        = $Case.Checks.Count
        passed       = $pass
        failed       = $fail
        unverifiable = $unverifiable
        checks       = $Case.Checks.ToArray()
        diagnostics  = $Case.Diagnostics.ToArray()
    }
    $dir = Split-Path -Parent $OutJson
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json = $result | ConvertTo-Json -Depth 6
    # WriteAllText with an explicit UTF-8 (no BOM) encoder: Set-Content -Encoding
    # UTF8 in PowerShell 5.1 emits a BOM, which some JSON readers reject.
    [System.IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding($false)))
    return $result
}

function Get-UiCaseFailure {
    <#
    .SYNOPSIS
        Build the failure text for a thrown exception, including the UIA
        inventory that UiDriver appends to lookup failures.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$ErrorRecord)
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("$($ErrorRecord.Exception.GetType().Name): $($ErrorRecord.Exception.Message)")
    if ($ErrorRecord.ScriptStackTrace) {
        $lines.Add('  at:')
        foreach ($line in ($ErrorRecord.ScriptStackTrace -split "`n")) { $lines.Add("    $line") }
    }
    return ($lines -join [Environment]::NewLine)
}

Export-ModuleMember -Function @(
    'New-UiCase', 'Add-UiCheck', 'Add-UiAssert', 'Add-UiUnverifiable',
    'Add-UiDiagnostic', 'Complete-UiCase', 'Get-UiCaseFailure'
)
