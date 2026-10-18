[CmdletBinding()]
param(
    [string]$ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe',
    [string]$ProfilePath = (Join-Path $env:LOCALAPPDATA 'Chrome-MCP-MiddleClick-enhanced'),
    [ValidateRange(1, 65535)][int]$Port = 9223,
    [ValidateRange(1, 120)][int]$TimeoutSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-SwitchValues([string]$CommandLine, [string]$Name) {
    $key = [regex]::Escape($Name)
    $pattern = '(?:^|\s)(?:"--{0}=([^"]*)"|--{0}="([^"]*)"|--{0}=([^\s"]+)|--{0}\s+"([^"]*)"|--{0}\s+([^\s"]+))(?=\s|$)' -f $key
    foreach ($match in [regex]::Matches($CommandLine, $pattern)) {
        for ($index = 1; $index -le 5; $index++) {
            if ($match.Groups[$index].Success) { $match.Groups[$index].Value; break }
        }
    }
}

function Get-Listeners {
    # Enumerate first: an unavailable TCP provider must not look like a free port.
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $Port)
}

function Assert-ChromeProcess($Process) {
    if (!$Process -or !$Process.ExecutablePath -or !$Process.CommandLine) {
        throw 'Process executable/arguments unavailable; cannot verify dedicated Chrome.'
    }
    if ($Process.Name -ine 'chrome.exe' -or $Process.ExecutablePath -ine $ChromePath) {
        throw "Port conflict: PID $($Process.ProcessId) is not the configured Google Chrome."
    }
    $profiles = @(Get-SwitchValues $Process.CommandLine 'user-data-dir')
    $ports = @(Get-SwitchValues $Process.CommandLine 'remote-debugging-port')
    if ($profiles.Count -ne 1 -or $ports.Count -ne 1) {
        throw "PID $($Process.ProcessId): missing or duplicate profile/debugging switches."
    }
    if ([IO.Path]::GetFullPath($profiles[0]).TrimEnd('\') -ine $ProfilePath -or $ports[0] -ne "$Port") {
        throw "PID $($Process.ProcessId): profile or debugging port mismatch."
    }
}

try {
    $ChromePath = (Resolve-Path -LiteralPath $ChromePath).ProviderPath
    $ProfilePath = [IO.Path]::GetFullPath($ProfilePath).TrimEnd('\')
    if ($ProfilePath.Contains('"')) { throw 'Profile path must not contain quotes.' }
    $chromeProcesses = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" -ErrorAction Stop)
    $dedicated = @()
    foreach ($process in $chromeProcesses) {
        if (!$process.CommandLine) { throw "PID $($process.ProcessId): Chrome arguments unavailable; cannot determine profile use." }
        foreach ($profile in @(Get-SwitchValues $process.CommandLine 'user-data-dir')) {
            if ([IO.Path]::GetFullPath($profile).TrimEnd('\') -ieq $ProfilePath) {
                if ($process.CommandLine -notmatch '(?:^|\s)--type=') { $dedicated += $process }
                break
            }
        }
    }
    $listeners = @(Get-Listeners)
    if ($listeners.Count) {
        foreach ($listener in $listeners) {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
            Assert-ChromeProcess $owner
        }
        Write-Host 'Reusing verified dedicated Chrome.'
    } else {
        if ($dedicated.Count) { throw 'Dedicated profile is already running without the expected listener. Close it manually after coordinating with other operators; no restart was attempted.' }
        Start-Process -FilePath $ChromePath -ArgumentList @("--remote-debugging-port=$Port", "--user-data-dir=`"$ProfilePath`"") -WindowStyle Hidden | Out-Null
        Write-Host 'Started dedicated Chrome; waiting for verified listener.'
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $version = $null
    do {
        $listeners = @(Get-Listeners)
        if ($listeners.Count) {
            foreach ($listener in $listeners) {
                $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
                Assert-ChromeProcess $owner
            }
            try {
                $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
            } catch { $version = $null }
            if ($version) { break }
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if (!$version -or $version.Browser -notlike 'Chrome/*' -or !$version.webSocketDebuggerUrl) {
        throw 'Debugging endpoint unavailable or invalid after process verification.'
    }
    [pscustomobject]@{
        Browser = $version.Browser
        ChromePath = $ChromePath
        ProfilePath = $ProfilePath
        BrowserUrl = "http://127.0.0.1:$Port"
        ProcessIds = @($listeners.OwningProcess | Select-Object -Unique)
    }
} catch {
    Write-Error "Dedicated Chrome verification failed: $($_.Exception.Message)" -ErrorAction Continue
    exit 1
}
