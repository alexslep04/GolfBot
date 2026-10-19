param([string]$Case, [string]$Directory)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\sharing.ps1"

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Assert-Throws([scriptblock]$Action) {
    $threw = $false
    try { & $Action } catch { $threw = $true }
    Assert $threw 'Expected the operation to fail.'
}

switch ($Case) {
    'urls' {
        Assert ((ConvertTo-ShareUrl ' My-Table.NGROK-FREE.DEV/ ') -eq 'https://my-table.ngrok-free.dev') 'Domain was not normalized.'
        foreach ($url in @('http://table.ngrok-free.dev', 'https://table.ngrok-free.dev/lobby/1',
            'https://table.ngrok-free.dev?x=1', 'https://table.ngrok-free.dev#x',
            'https://user@table.ngrok-free.dev', 'https://table.ngrok-free.dev:8000',
            'https://table.ngrok-free.dev.evil.test', 'file:///test', '--config=other', '')) {
            Assert-Throws { ConvertTo-ShareUrl $url }
        }
    }
    'persistence' {
        $settingsPath = Join-Path $Directory 'saved.json'
        $token = ConvertTo-SecureString 'test-only-token' -AsPlainText -Force
        Save-ShareSettings $settingsPath 'table.ngrok-free.dev' $token
        $token.Dispose()
        Assert ((Get-Content $settingsPath -Raw) -notmatch 'test-only-token') 'Plaintext token was saved.'
        # Read it in a new PowerShell process, as after closing/reopening share.bat.
        $result = & powershell.exe -NoProfile -File "$PSCommandPath" -Case 'read-persisted' -Directory $Directory
        Assert ($LASTEXITCODE -eq 0 -and $result -contains 'PASS read-persisted') 'Settings failed across sessions.'
    }
    'read-persisted' {
        $settings = Read-ShareSettings (Join-Path $Directory 'saved.json')
        Assert ($settings.url -eq 'https://table.ngrok-free.dev') 'Address changed after restart.'
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($settings.token)
        try {
            Assert ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -eq 'test-only-token') 'Token failed to decrypt.'
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            $settings.token.Dispose()
        }
    }
    'bad-settings' {
        $settingsPath = Join-Path $Directory 'bad.json'
        foreach ($value in @('not json', '{"version":99}', '{"version":1,"url":"table.ngrok-free.dev","encryptedToken":"bad"}')) {
            Set-Content $settingsPath $value
            Assert-Throws { Read-ShareSettings $settingsPath }
        }
        Assert-Throws { Save-ShareSettings $settingsPath 'table.ngrok-free.dev' (New-Object Security.SecureString) }
    }
    'launch' {
        function Start-Process {
            param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
            $script:captured = @{ args = $ArgumentList; token = $env:NGROK_AUTHTOKEN; window = $WindowStyle }
            if ($script:failLaunch) { throw 'Simulated launch failure.' }
            return [pscustomobject]@{ Id = 12345 }
        }
        $env:NGROK_AUTHTOKEN = 'previous-environment'
        $token = ConvertTo-SecureString 'test-only-token' -AsPlainText -Force
        $process = Start-ShareProcess 'unused.exe' 'https://table.ngrok-free.dev' 8002 $token $Directory
        Assert ($process.Id -eq 12345) 'No child process returned.'
        Assert ($script:captured.token -eq 'test-only-token') 'Child did not inherit token.'
        Assert ($env:NGROK_AUTHTOKEN -eq 'previous-environment') 'Parent token was not restored.'
        Assert ($script:captured.window -eq 'Hidden') 'Helper window is not hidden.'
        Assert ($script:captured.args -contains 'http://127.0.0.1:8002') 'Wrong upstream port.'
        Assert ($script:captured.args -contains 'https://table.ngrok-free.dev') 'Saved URL was not requested.'
        Assert (($script:captured.args -join ' ') -notmatch 'test-only-token') 'Token leaked into command line.'
        $config = Get-Content (Join-Path $Directory 'ngrok-agent.yml') -Raw
        Assert ($config -notmatch 'test-only-token' -and $config -match 'web_addr: false') 'Configuration exposes credentials or inspector.'
        $script:failLaunch = $true
        Assert-Throws { Start-ShareProcess 'unused.exe' 'https://table.ngrok-free.dev' 8002 $token $Directory }
        Assert ($env:NGROK_AUTHTOKEN -eq 'previous-environment') 'Launch failure did not restore environment.'
        $token.Dispose()
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
        function Start-ShareProcess {
            param($Executable, $Url, $Port, $Token, $Directory)
            $script:attempts += $Url
            $child = [pscustomobject]@{ Id = 100 + $script:attempts.Count; HasExited = ($script:attempts.Count -eq 1); Disposed = $false; Killed = $false }
            $child | Add-Member ScriptMethod Refresh { Set-Content $script:stopPath 'stop' }
            $child | Add-Member ScriptMethod Kill { $this.Killed = $true; $this.HasExited = $true }
            $child | Add-Member ScriptMethod WaitForExit { }
            $child | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
            $script:children += $child
            return $child
        }
        Watch-ShareProcess 'unused.exe' @{ url = 'https://table.ngrok-free.dev'; token = $null } 8000 $Directory
        $expectedAttempts = if ($script:stopDuringRetry) { 1 } else { 2 }
        Assert ($script:attempts.Count -eq $expectedAttempts) 'Retry or explicit shutdown was not honored.'
        Assert (@($script:attempts | Where-Object { $_ -ne 'https://table.ngrok-free.dev' }).Count -eq 0) 'Address changed on reconnect.'
        Assert (@($script:children | Where-Object { -not $_.Disposed }).Count -eq 0) 'Child handle leaked.'
        Assert (-not (Test-Path (Join-Path $Directory 'tunnel.pid'))) 'Stale child PID remained.'
        if (-not $script:stopDuringRetry) { Assert $script:children[1].Killed 'Live child did not stop on shutdown.' }
    }
    'supervisor' {
        $artifacts = Join-Path $Directory '.artifacts'
        New-Item -ItemType Directory -Path $artifacts | Out-Null
        $token = ConvertTo-SecureString 'test-only-token' -AsPlainText -Force
        Save-ShareSettings (Join-Path $artifacts 'share-settings.json') 'table.ngrok-free.dev' $token
        $token.Dispose()
        function Get-NgrokExecutable { return 'unused.exe' }
        function Watch-ShareProcess {
            param($Executable, $Settings, $Port, $Directory)
            Assert-Throws { Start-GolfSharing -Root (Split-Path $Directory) -Port $Port }
            $script:runs++
        }
        $script:runs = 0
        Start-GolfSharing $Directory 8000
        Start-GolfSharing $Directory 8000
        Assert ($script:runs -eq 2) 'Supervisor lock was not released for a new session.'
        Assert (-not (Test-Path (Join-Path $artifacts 'share.pid'))) 'Stale supervisor PID remained.'
        Assert (Test-Path (Join-Path $artifacts 'share-settings.json')) 'Shutdown removed persistent settings.'
    }
    'stop-hosting' {
        $global:golfSharingTestRoot = $Directory
        $artifacts = Join-Path $Directory '.artifacts'
        New-Item -ItemType Directory -Path $artifacts | Out-Null
        Copy-Item "$PSScriptRoot\..\stop-hosting.ps1" (Join-Path $Directory 'stop-hosting.ps1')
        Set-Content (Join-Path $artifacts 'share.pid') '11'
        Set-Content (Join-Path $artifacts 'tunnel.pid') '12'
        Set-Content (Join-Path $artifacts 'server.pid') '13'
        Set-Content (Join-Path $artifacts 'share-settings.json') 'keep settings'
        $global:golfSharingTestTerminated = @()
        function Get-CimInstance {
            param($ClassName, $Filter)
            switch ($Filter) {
                'ProcessId=11' { return [pscustomobject]@{ Name = 'powershell.exe'; ProcessId = 11; CommandLine = "powershell -File `"$global:golfSharingTestRoot\share.ps1`"" } }
                'ProcessId=12' { return [pscustomobject]@{ ProcessId = 12; ExecutablePath = "$global:golfSharingTestRoot\.artifacts\tools\ngrok.exe" } }
                'ProcessId=13' { return [pscustomobject]@{ ProcessId = 13; CommandLine = "python `"$global:golfSharingTestRoot\launch.py`"" } }
            }
        }
        function Invoke-CimMethod {
            param($InputObject, $MethodName)
            Assert (Test-Path "$global:golfSharingTestRoot\.artifacts\share.stop") 'Retry was not disabled before terminating processes.'
            $global:golfSharingTestTerminated += $InputObject.ProcessId
            return @{ ReturnValue = 0 }
        }
        & (Join-Path $Directory 'stop-hosting.ps1')
        Assert (($global:golfSharingTestTerminated -join ',') -eq '11,12,13') 'Wrong shutdown order.'
        Assert ((Get-Content (Join-Path $artifacts 'share-settings.json') -Raw).Trim() -eq 'keep settings') 'Stop removed saved settings.'
        # A reused PID from another checkout must never be terminated.
        Set-Content (Join-Path $artifacts 'share.pid') '99'
        function Get-CimInstance { return [pscustomobject]@{ Name = 'powershell.exe'; ProcessId = 99; CommandLine = 'powershell -File C:\other\share.ps1' } }
        Assert-Throws { & (Join-Path $Directory 'stop-hosting.ps1') }
        Assert ($global:golfSharingTestTerminated.Count -eq 3) 'Stopped an unrelated process.'
    }
    default { throw "Unknown case: $Case" }
}
Write-Output "PASS $Case"
