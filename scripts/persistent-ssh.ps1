# Persistent SSH Operations CLI. Keep this file ASCII for Windows PowerShell 5.1.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('config-path','start','status','stop','hostkey-show','hostkey-approve','exec')]
    [string]$Action,

    [Parameter(Position = 1)]
    [string]$Profile = 'default',

    [Parameter(Position = 2)]
    [string]$RemoteCommand,

    [int]$TimeoutSec = 300,
    [string]$Fingerprint,
    [string]$ConfigPath,
    [string]$StateRoot
)

$ErrorActionPreference = 'Stop'
trap {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 127
}
$skillRoot = Split-Path $PSScriptRoot -Parent
$broker = Join-Path $PSScriptRoot 'persistent-ssh-broker.cjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source

if (-not $ConfigPath) {
    if ($env:PERSISTENT_SSH_CONFIG) { $ConfigPath = $env:PERSISTENT_SSH_CONFIG }
    else { $ConfigPath = Join-Path $env:APPDATA 'persistent-ssh-operations\profiles.json' }
}
if (-not $StateRoot) {
    if ($env:PERSISTENT_SSH_STATE_DIR) { $StateRoot = $env:PERSISTENT_SSH_STATE_DIR }
    else { $StateRoot = Join-Path $env:LOCALAPPDATA 'persistent-ssh-operations' }
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$StateRoot = [IO.Path]::GetFullPath($StateRoot)

function Assert-ProfileName {
    if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'Profile names must use 1-64 letters, digits, dots, underscores, or hyphens.'
    }
}

function Get-ProfilePaths {
    Assert-ProfileName
    $base = Join-Path $StateRoot $Profile
    return @{
        Base = $base
        Queue = Join-Path $base 'queue'
        Results = Join-Path $base 'results'
        Heartbeat = Join-Path $base 'heartbeat.json'
        PendingHost = Join-Path $base 'pending-host.json'
        KnownHost = Join-Path $base 'known-host.json'
    }
}

function Write-AtomicJson([string]$Path, [object]$Value) {
    $directory = Split-Path $Path -Parent
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Compress), $utf8)
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { return $null }
}

function Get-Heartbeat {
    $paths = Get-ProfilePaths
    $heartbeat = Read-Json $paths.Heartbeat
    if (-not $heartbeat) { return $null }
    try {
        $age = ([DateTime]::UtcNow - [DateTime]::Parse($heartbeat.updatedAt).ToUniversalTime()).TotalSeconds
        if ($age -gt 20) { return $null }
    } catch { return $null }
    return $heartbeat
}

function Ensure-Dependency {
    $module = Join-Path $skillRoot 'node_modules\ssh2'
    if (Test-Path -LiteralPath $module) { return }
    New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
    $installLock = Join-Path $StateRoot 'dependency-install.lock'
    $stream = $null
    $deadline = (Get-Date).AddMinutes(5)
    while (-not $stream -and (Get-Date) -lt $deadline) {
        try { $stream = [IO.File]::Open($installLock, 'OpenOrCreate', 'ReadWrite', 'None') }
        catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $stream) { throw 'Timed out waiting for the dependency installation lock.' }
    try {
        if (-not (Test-Path -LiteralPath $module)) {
            & npm.cmd ci --prefix $skillRoot --ignore-scripts --omit=dev
            if ($LASTEXITCODE -ne 0) { throw 'Pinned ssh2 dependency installation failed.' }
        }
    } finally {
        $stream.Dispose()
        Remove-Item -LiteralPath $installLock -Force -ErrorAction SilentlyContinue
    }
}

function Quote-ProcessArgument([string]$Value) {
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-Broker {
    $current = Get-Heartbeat
    if (-not $current) {
        if (-not (Test-Path -LiteralPath $ConfigPath)) {
            throw "Profile config does not exist: $ConfigPath"
        }
        Ensure-Dependency
        & $node $broker --validate --config $ConfigPath --state-root $StateRoot --profile $Profile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Profile validation failed.' }

        $arguments = @(
            (Quote-ProcessArgument $broker),
            '--config', (Quote-ProcessArgument $ConfigPath),
            '--state-root', (Quote-ProcessArgument $StateRoot),
            '--profile', (Quote-ProcessArgument $Profile)
        )
        Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $current = Get-Heartbeat
        if ($current -and ($current.state -eq 'ready' -or $current.state -eq 'hostkey-pending')) { return $current }
        Start-Sleep -Milliseconds 300
    }
    throw 'Broker did not reach ready or hostkey-pending state within 30 seconds.'
}

function Invoke-BrokerRequest([string]$Type, [string]$Command, [int]$Seconds) {
    $paths = Get-ProfilePaths
    New-Item -ItemType Directory -Force -Path $paths.Queue,$paths.Results | Out-Null
    $id = [guid]::NewGuid().ToString('N')
    $request = @{
        id = $id
        type = $Type
        timeoutMs = [Math]::Max(1000, $Seconds * 1000)
        deadlineMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ([Math]::Max(1000, $Seconds * 1000)) + 10000
    }
    if ($Command) { $request.command = $Command }
    $requestPath = Join-Path $paths.Queue "$id.req.json"
    $runPath = Join-Path $paths.Queue "$id.run.json"
    $responsePath = Join-Path $paths.Results "$id.resp.json"
    Write-AtomicJson $requestPath $request

    $deadline = (Get-Date).AddSeconds($Seconds + 15)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $responsePath) {
            $result = Read-Json $responsePath
            Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue
            if (-not $result) { throw 'Broker returned an invalid response.' }
            if ($result.stdout) { [Console]::Out.Write([string]$result.stdout) }
            if ($result.stderr) { [Console]::Error.Write([string]$result.stderr) }
            return [int]$result.code
        }
        Start-Sleep -Milliseconds 200
    }

    if (Test-Path -LiteralPath $requestPath) {
        Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
        [Console]::Error.WriteLine('Request expired locally before the broker claimed it; it was not executed.')
        return 124
    }
    if (Test-Path -LiteralPath $runPath) {
        [Console]::Error.WriteLine('Broker response timed out after execution started; remote completion is uncertain.')
        return 125
    }
    [Console]::Error.WriteLine('Broker response was lost; remote completion is uncertain.')
    return 125
}

if ($Action -eq 'config-path') {
    [Console]::Out.WriteLine($ConfigPath)
    exit 0
}

Assert-ProfileName
$paths = Get-ProfilePaths

switch ($Action) {
    'status' {
        $heartbeat = Get-Heartbeat
        if ($heartbeat) { $heartbeat | ConvertTo-Json -Depth 5; exit 0 }
        [Console]::Out.WriteLine('{"state":"stopped"}')
        exit 1
    }
    'hostkey-show' {
        $known = Read-Json $paths.KnownHost
        $pending = Read-Json $paths.PendingHost
        @{ profile = $Profile; known = $known; pending = $pending } | ConvertTo-Json -Depth 6
        if ($pending) { exit 126 }
        exit 0
    }
    'hostkey-approve' {
        if (-not $Fingerprint) { throw 'hostkey-approve requires -Fingerprint with the exact verified SHA256 value.' }
        $pending = Read-Json $paths.PendingHost
        if (-not $pending) { throw 'No pending host key exists for this profile.' }
        if ($pending.fingerprint -cne $Fingerprint) { throw 'The supplied fingerprint does not exactly match the pending host key.' }
        Write-AtomicJson $paths.KnownHost @{
            profile = $Profile
            host = $pending.host
            port = [int]$pending.port
            fingerprint = $pending.fingerprint
            approvedAt = [DateTime]::UtcNow.ToString('o')
        }
        Remove-Item -LiteralPath $paths.PendingHost -Force -ErrorAction SilentlyContinue
        [Console]::Out.WriteLine("Approved $Fingerprint for $($pending.host):$($pending.port).")
        exit 0
    }
    'start' {
        $heartbeat = Start-Broker
        $heartbeat | ConvertTo-Json -Depth 5
        if ($heartbeat.state -eq 'hostkey-pending') { exit 126 }
        exit 0
    }
    'stop' {
        $heartbeat = Get-Heartbeat
        if (-not $heartbeat) { [Console]::Out.WriteLine('Broker is already stopped.'); exit 0 }
        exit (Invoke-BrokerRequest 'stop' $null 15)
    }
    'exec' {
        if (-not $RemoteCommand) { throw 'exec requires a non-empty remote command.' }
        if ($TimeoutSec -lt 1 -or $TimeoutSec -gt 86400) { throw 'TimeoutSec must be between 1 and 86400.' }
        $heartbeat = Start-Broker
        if ($heartbeat.state -eq 'hostkey-pending') {
            [Console]::Error.WriteLine('Host-key approval is required. Run hostkey-show, verify independently, then hostkey-approve.')
            exit 126
        }
        exit (Invoke-BrokerRequest 'exec' $RemoteCommand $TimeoutSec)
    }
}
