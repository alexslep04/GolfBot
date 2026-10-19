param([ValidateRange(1, 65535)][int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-TunnelHash([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
    if ($health.status -ne 'ok') { throw 'Unexpected health response.' }
} catch {
    throw 'Start play.bat first, leave its window open, then run share.bat.'
}

# Official portable release, pinned and verified before execution. No install needed.
$releaseVersion = '2026.10.0'
$expectedHash = '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c'
$toolDirectory = Join-Path $PSScriptRoot '.artifacts\tools'
$tunnelExecutable = Join-Path $toolDirectory 'cloudflared.exe'
New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $tunnelExecutable) -or (Get-TunnelHash $tunnelExecutable) -ne $expectedHash) {
    Write-Host 'Downloading the official Cloudflare tunnel helper...'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/download/$releaseVersion/cloudflared-windows-amd64.exe" -OutFile $tunnelExecutable
}
if ((Get-TunnelHash $tunnelExecutable) -ne $expectedHash) {
    throw 'The tunnel helper checksum did not match. It has not been run.'
}

Write-Host 'Open the https://...trycloudflare.com link printed below on your own computer too.'
Write-Host 'Host a lobby there and use Copy link to invite your opponent.'
Write-Host 'Keep both windows open. Ctrl+C in this window stops public sharing.'
$pidFile = Join-Path $PSScriptRoot '.artifacts\tunnel.pid'
if (Test-Path -LiteralPath $pidFile) {
    $existingProcess = Get-Process -Id ([int](Get-Content -LiteralPath $pidFile -Raw).Trim()) -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.Path -eq $tunnelExecutable) {
        throw 'Sharing is already running. Use stop-hosting.bat before starting another tunnel.'
    }
}
$tunnelLog = Join-Path $PSScriptRoot '.artifacts\tunnel.stderr.log'
$outputLog = Join-Path $PSScriptRoot '.artifacts\tunnel.stdout.log'
$tunnelProcess = Start-Process -FilePath $tunnelExecutable -ArgumentList 'tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate' -WindowStyle Hidden -RedirectStandardError $tunnelLog -RedirectStandardOutput $outputLog -PassThru
$tunnelProcess.Id | Set-Content -LiteralPath $pidFile
$printedLines = 0
try {
    while (-not $tunnelProcess.HasExited) {
        $lines = @(Get-Content -LiteralPath $tunnelLog -ErrorAction SilentlyContinue)
        $lines | Select-Object -Skip $printedLines | ForEach-Object { Write-Host $_ }
        $printedLines = $lines.Count
        Start-Sleep -Milliseconds 500
        $tunnelProcess.Refresh()
    }
} finally {
    if (-not $tunnelProcess.HasExited) { $tunnelProcess.Kill() }
    if ((Test-Path -LiteralPath $pidFile) -and (Get-Content -LiteralPath $pidFile -Raw).Trim() -eq [string]$tunnelProcess.Id) {
        Remove-Item -LiteralPath $pidFile
    }
}
if ($tunnelProcess.ExitCode) { throw "The tunnel stopped with exit code $($tunnelProcess.ExitCode)." }
