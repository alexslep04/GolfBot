$ErrorActionPreference = 'Stop'
$directory = Join-Path $PSScriptRoot '.artifacts'
if (Test-Path -LiteralPath $directory) {
    Set-Content -LiteralPath (Join-Path $directory 'share.stop') -Value 'stop'
}
foreach ($serviceName in 'share', 'tunnel', 'server') {
    $pidFile = Join-Path $PSScriptRoot ".artifacts\$serviceName.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { continue }
    $hostProcessId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    $hostProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$hostProcessId"
    if (-not $hostProcess) { Remove-Item -LiteralPath $pidFile; continue }
    # Refuse a stale PID belonging to another program or checkout.
    $workspacePattern = [regex]::Escape($PSScriptRoot)
    $expected = if ($serviceName -eq 'share') {
        $hostProcess.Name -in @('powershell.exe', 'pwsh.exe') -and
            $hostProcess.CommandLine -match $workspacePattern -and $hostProcess.CommandLine -match '\bshare\.ps1\b'
    } elseif ($serviceName -eq 'tunnel') {
        $hostProcess.ExecutablePath -eq (Join-Path $PSScriptRoot '.artifacts\tools\cloudflared.exe')
    } else {
        $hostProcess.CommandLine -match $workspacePattern -and $hostProcess.CommandLine -match '(launch\.py|-m launch\b|server:app)'
    }
    if (-not $expected) { throw "Refusing to stop an unrelated process ($hostProcessId)." }
    $termination = Invoke-CimMethod -InputObject $hostProcess -MethodName Terminate
    if ($termination.ReturnValue -ne 0) { throw "Could not stop GolfBot $serviceName (code $($termination.ReturnValue))." }
    Remove-Item -LiteralPath $pidFile
    Write-Host "Stopped GolfBot $serviceName."
}
