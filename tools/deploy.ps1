# Puts a freshly built proxy into service, and takes it back out again if it does not answer.
#
# The production proxy is the Rust `proxy_rs.node` module hosted by node, so deploying it is a file
# copy rather than a build: `cargo build --release --lib` writes `proxy_rs.dll`, and the service loads
# `proxy_rs.node`, which is a copy of it. The copy is what cannot happen while the service is running,
# because node holds the file open.
#
# **The blast radius is every public host name on this machine**, not one service: ai.jasonmcaffee.com,
# the personal site, Plex, Gitea, Phone Sync, Chordical, Black Rainbow, Unluminous, Inillucent and the
# agent tasks board all reach their upstream through this one process. It is down for the few seconds
# between the stop and the start, so this wants a quiet moment the same way the board does.
#
# The way back is a copy kept aside before the swap. By hand:
#
#   pwsh tools/deploy.ps1 -Rollback
#
# Usage:
#   pwsh tools/deploy.ps1 -WhatIf
#   pwsh tools/deploy.ps1
#   pwsh tools/deploy.ps1 -Rollback

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ServiceManager = 'http://localhost:4000',
    [string]$ServiceId = 'cml9m50i30006vh3hlbxr79zb',
    [switch]$Rollback,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$built = Join-Path $repository 'target\release\proxy_rs.dll'
$live = Join-Path $repository 'target\release\proxy_rs.node'
$previous = "$live.previous"

<#
.SYNOPSIS
Asks the Service Manager to start or stop the proxy, and returns the status it reports.
.PARAMETER Action
'stop' or 'start'.
#>
function Invoke-ServiceAction {
    param([string]$Action)
    $body = @{ action = $Action } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod -Method POST -Uri "$ServiceManager/api/services/$ServiceId/control" -ContentType 'application/json' -Body $body
    return $response.status
}

<#
.SYNOPSIS
Checks the proxy is listening, ready, and still routing by host, and returns $true only if all three
hold.
.DESCRIPTION
`/__proxy/health` and `/__proxy/ready` are loopback-only and say the listener came up. Neither says
the routing table survived, so this also asks for a host that has an upstream and one that does not:
the unrouted name must still reach the personal site, which is the arm a new host route is most
likely to have broken.
#>
function Test-Proxy {
    $ok = $true
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1/__proxy/health' -TimeoutSec 10
        Write-Host "  health:  $($health.status) version $($health.version)"
        if ($health.status -ne 'ok') { $ok = $false }
    } catch {
        Write-Host "  health:  did not answer — $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
    try {
        $ready = (Invoke-WebRequest -Uri 'http://127.0.0.1/__proxy/ready' -TimeoutSec 10 -SkipHttpErrorCheck).StatusCode
        Write-Host "  ready:   $ready (want 200)"
        if ($ready -ne 200) { $ok = $false }
    } catch {
        Write-Host '  ready:   did not answer' -ForegroundColor Red
        $ok = $false
    }
    foreach ($case in @(
            @{ Host = 'jasonmcaffee.com'; What = 'the personal site, the unrouted catch-all' },
            @{ Host = 'ai.jasonmcaffee.com'; What = 'the AI Studio UI' },
            @{ Host = 'tasks.jasonmcaffee.com'; What = 'the agent tasks board' })) {
        $code = Get-StatusCode -Uri 'http://127.0.0.1/' -HostHeader $case.Host
        Write-Host "  $($case.Host): $code — $($case.What)"
        if ($code -eq 0) {
            $ok = $false
        } elseif ($code -ge 500 -and $code -ne 502) {
            # Any HTTP answer means the proxy chose an upstream and reached it. A 502 means it chose
            # one that is not running, which is a fact about that upstream rather than about routing.
            $ok = $false
        }
    }
    return $ok
}

<#
.SYNOPSIS
The status code one request answers with, or 0 when nothing answered at all.
.DESCRIPTION
**A redirect is an answer, and this deliberately does not use `Invoke-WebRequest` to read one.**
`ai.jasonmcaffee.com` answers `307` to an unauthenticated request for `/`. With
`-MaximumRedirection 0` that raises a PowerShell error carrying no response at all, so the status
cannot be recovered from it and the check read a healthy host as dead — which would have rolled back
a good deploy, the one outcome worse than the failure it was guarding against. Following the redirect
instead is no better: it leaves the proxy's answer behind and reports the login page's.

`curl.exe` reports a redirect as the status it is and never raises, so that is what asks.
.PARAMETER Uri
The URL to request.
.PARAMETER HostHeader
The host name to send, which is what the proxy routes on.
#>
function Get-StatusCode {
    param([string]$Uri, [string]$HostHeader)
    $code = & curl.exe --silent --output NUL --max-time 15 --write-out '%{http_code}' --header "Host: $HostHeader" $Uri 2>$null
    if ($LASTEXITCODE -ne 0) { return 0 }
    $parsed = 0
    if ([int]::TryParse(($code | Select-Object -Last 1), [ref]$parsed)) { return $parsed }
    return 0
}

<#
.SYNOPSIS
Puts the previous module back and restarts the proxy.
#>
function Restore-Previous {
    if (-not (Test-Path $previous)) { throw "there is no $previous to go back to" }
    Write-Host 'rolling back...' -ForegroundColor Yellow
    Invoke-ServiceAction -Action 'stop' | Out-Null
    Copy-Item $previous $live -Force
    Write-Host "  restored $live from $previous"
    Invoke-ServiceAction -Action 'start' | Out-Null
    Start-Sleep -Seconds 4
    if (Test-Proxy) {
        Write-Host 'the previous module is back and the proxy is answering' -ForegroundColor Green
    } else {
        Write-Host 'the previous module is back but the proxy still is not answering' -ForegroundColor Red
    }
}

if ($Rollback) {
    Restore-Previous
    return
}

if (-not $SkipBuild) {
    # Set explicitly: cargo reads .cargo/config.toml from the WORKING directory's hierarchy rather
    # than the manifest's, and a retired agent worktree on this machine holds one that redirects
    # target-dir to a scratch drive — a build run from there reports success and writes nothing here.
    $env:CARGO_TARGET_DIR = Join-Path $repository 'target'
    Write-Host "building the module into $env:CARGO_TARGET_DIR ..."
    & cargo build --release --manifest-path (Join-Path $repository 'Cargo.toml') --lib
    if ($LASTEXITCODE -ne 0) { throw "cargo build --release --lib exited $LASTEXITCODE" }
}

if (-not (Test-Path $built)) { throw "there is no $built to deploy" }
Write-Host "built module:  $built  ($((Get-Item $built).LastWriteTime))"
Write-Host "live module:   $live   ($((Get-Item $live).LastWriteTime))"

if (-not $PSCmdlet.ShouldProcess('every public host name on this machine', 'stop the proxy, swap its module, and start it')) {
    Write-Host 'nothing was changed'
    return
}

Copy-Item $live $previous -Force
Write-Host "kept the live module as $previous"

Write-Host "stopping the proxy: $(Invoke-ServiceAction -Action 'stop')"
Copy-Item $built $live -Force
Write-Host "swapped in the new module"
Write-Host "starting the proxy: $(Invoke-ServiceAction -Action 'start')"

Start-Sleep -Seconds 4
Write-Host 'checking the proxy...'
if (-not (Test-Proxy)) {
    Write-Host 'the new module is not answering — rolling back rather than leaving it up' -ForegroundColor Red
    Restore-Previous
    throw 'the new proxy module failed its check and was rolled back'
}
Write-Host 'the proxy is up on the new module' -ForegroundColor Green
Write-Host 'if anything looks wrong from here: pwsh tools/deploy.ps1 -Rollback'
