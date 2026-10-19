param([string]$Case, [string]$Directory)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\cloudflare-sharing.ps1"
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action) {
    $threw = $false
    try { & $Action } catch { $threw = $true }
    Assert $threw 'Expected failure.'
}
switch ($Case) {
    'download-verification' {
        $knownFile = Join-Path $Directory 'known.txt'
        [IO.File]::WriteAllText($knownFile, 'abc', (New-Object Text.UTF8Encoding($false)))
        Assert ((Get-TunnelHash $knownFile) -eq 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') 'SHA256 verification failed.'
        function Invoke-WebRequest {
            param([switch]$UseBasicParsing, $Uri, $OutFile)
            Set-Content -LiteralPath $OutFile -Value 'incorrect download'
        }
        Assert-Throws { Get-CloudflaredExecutable $Directory }
    }
    'configuration' {
        $artifacts = Join-Path $Directory '.artifacts\cloudflare'
        New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
        $credentials = Join-Path $artifacts 'credentials.json'
        Set-Content $credentials '{"TunnelID":"11111111-2222-3333-4444-555555555555","TunnelSecret":"test-only-secret"}'
        $path = Write-CloudflareConfig $Directory 8002
        $config = Get-Content $path -Raw
        Assert ($config -match 'tunnel: 11111111-2222-3333-4444-555555555555') 'Tunnel identity changed.'
        Assert ($config -match 'hostname: sleptsov.dev' -and $config -match 'http://127.0.0.1:8002') 'Wrong domain or local port.'
        Assert ($config -match [regex]::Escape("path: '^/Golfgame(/.*)?$'")) 'Public game path is not isolated.'
        Assert ($config -match 'http_status:404') 'Other paths are not reserved for a future website.'
        Assert ($config -notmatch 'test-only-secret') 'Credential leaked into configuration.'
        Assert-Throws { Write-CloudflareConfig $Directory 0 }
        Set-Content $credentials '{"TunnelID":"not-a-uuid"}'
        Assert-Throws { Write-CloudflareConfig $Directory 8000 }
    }
    'launch' {
        function Start-Process {
            param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
            $script:captured = @{ args = $ArgumentList; window = $WindowStyle }
            return [pscustomobject]@{ Id = 12345 }
        }
        $configPath = Join-Path $Directory 'config with spaces.yml'
        $child = Start-CloudflareProcess 'unused.exe' $configPath $Directory
        Assert ($child.Id -eq 12345 -and $script:captured.window -eq 'Hidden') 'Background helper did not launch.'
        Assert ($script:captured.args -contains "`"$configPath`"") 'Configuration path is not quoted.'
        Assert ($script:captured.args -contains 'run') 'Not running a named tunnel.'
        Assert ($script:captured.args -notcontains '--url' -and $script:captured.args -notcontains '--token') 'Using a temporary URL or credential arguments.'
    }
    { $_ -in 'reconnect', 'stop-during-retry' } {
        $script:attempts = @()
        $script:children = @()
        $script:stopPath = Join-Path $Directory 'share.stop'
        $script:stopDuringRetry = $Case -eq 'stop-during-retry'
        function Start-Sleep {
            param($Milliseconds)
            if ($script:stopDuringRetry) { Set-Content $script:stopPath 'stop' }
        }
        function Start-CloudflareProcess {
            param($Executable, $ConfigPath, $Directory)
            $script:attempts += $ConfigPath
            $child = [pscustomobject]@{ Id = 100 + $script:attempts.Count; HasExited = ($script:attempts.Count -eq 1); Disposed = $false; Killed = $false }
            $child | Add-Member ScriptMethod Refresh { Set-Content $script:stopPath 'stop' }
            $child | Add-Member ScriptMethod Kill { $this.Killed = $true; $this.HasExited = $true }
            $child | Add-Member ScriptMethod WaitForExit { }
            $child | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
            $script:children += $child
            return $child
        }
        Watch-CloudflareProcess 'unused.exe' 'same-tunnel.yml' $Directory
        $expectedAttempts = if ($script:stopDuringRetry) { 1 } else { 2 }
        Assert ($script:attempts.Count -eq $expectedAttempts) 'Retry or explicit shutdown was not honored.'
        Assert (@($script:attempts | Where-Object { $_ -ne 'same-tunnel.yml' }).Count -eq 0) 'Tunnel changed on reconnect.'
        Assert (@($script:children | Where-Object { -not $_.Disposed }).Count -eq 0) 'Child handle leaked.'
        Assert (-not (Test-Path (Join-Path $Directory 'tunnel.pid'))) 'Stale PID remained.'
        if (-not $script:stopDuringRetry) { Assert $script:children[1].Killed 'Child did not stop on shutdown.' }
    }
    'supervisor' {
        $artifacts = Join-Path $Directory '.artifacts\cloudflare'
        New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
        Set-Content (Join-Path $artifacts 'credentials.json') '{"TunnelID":"11111111-2222-3333-4444-555555555555"}'
        function Get-CloudflaredExecutable { return 'unused.exe' }
        function Watch-CloudflareProcess {
            param($Executable, $ConfigPath, $Directory)
            Assert-Throws { Start-GolfSharing -Root (Split-Path $Directory) }
            $script:runs++
        }
        $script:runs = 0
        Start-GolfSharing $Directory
        Start-GolfSharing $Directory
        Assert ($script:runs -eq 2) 'Could not reopen sharing after stopping.'
        Assert (Test-Path (Join-Path $artifacts 'credentials.json')) 'Persistent credentials were removed.'
        Assert (-not (Test-Path (Join-Path (Split-Path $artifacts) 'share.pid'))) 'Supervisor PID remained.'
    }
    default { throw "Unknown case: $Case" }
}
Write-Output "PASS $Case"
