param(
    [ValidateRange(1, 65535)][int]$Port = 8000,
    [switch]$Setup
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. "$PSScriptRoot\cloudflare-sharing.ps1"
try {
    Start-GolfSharing -Root $PSScriptRoot -Port $Port -Setup:$Setup
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
