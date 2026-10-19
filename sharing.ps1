# Shared functions are separate so lifecycle tests never open a public tunnel.
# Use this host's built-in module even when launched from PowerShell 7/Python.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

function ConvertTo-ShareUrl([string]$Value) {
    $candidate = $Value.Trim()
    if ($candidate -notmatch '://') { $candidate = "https://$candidate" }
    $uri = $null
    if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or $uri.Port -ne 443 -or $uri.UserInfo -or
        $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or
        $uri.DnsSafeHost -notmatch '^[a-z0-9-]+\.(ngrok-free\.(dev|app)|ngrok\.(dev|app|io))$') {
        throw 'Enter your assigned ngrok dev domain, such as https://your-name.ngrok-free.dev (no lobby path).'
    }
    return "https://$($uri.DnsSafeHost.ToLowerInvariant())"
}

function Save-ShareSettings([string]$Path, [string]$Url, [Security.SecureString]$Token) {
    $urlValue = ConvertTo-ShareUrl $Url
    if (-not $Token -or $Token.Length -eq 0) { throw 'An ngrok authtoken is required.' }
    # Windows DPAPI: only this Windows user on this computer can decrypt it.
    $settings = @{ version = 1; url = $urlValue; encryptedToken = (ConvertFrom-SecureString $Token) }
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $settings | ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
    }
}

function Read-ShareSettings([string]$Path) {
    try {
        $settings = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if ($settings.version -ne 1 -or -not $settings.encryptedToken) { throw 'Invalid configuration.' }
        $urlValue = ConvertTo-ShareUrl $settings.url
        $token = ConvertTo-SecureString $settings.encryptedToken
        if ($token.Length -eq 0) { throw 'Empty token.' }
        return @{ url = $urlValue; token = $token }
    } catch {
        throw 'Cannot read saved sharing settings. Run share.bat -Setup as this Windows user to configure them again.'
    }
}

function Set-UpSharing([string]$Path) {
    Write-Host 'One-time setup: create a free account at https://dashboard.ngrok.com/signup'
    Write-Host 'Copy your assigned dev domain from https://dashboard.ngrok.com/domains'
    Write-Host 'Copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken'
    $urlValue = ConvertTo-ShareUrl (Read-Host 'Your ngrok dev domain')
    $token = Read-Host 'Authtoken (hidden; stored encrypted on this computer)' -AsSecureString
    try { Save-ShareSettings -Path $Path -Url $urlValue -Token $token }
    finally { if ($token) { $token.Dispose() } }
    Write-Host "Saved permanent share address: $urlValue"
}

function Test-NgrokSignature([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return ($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'O="?ngrok, Inc\."?(,|$)')
}

function Get-NgrokExecutable([string]$Directory) {
    $executable = Join-Path $Directory 'ngrok.exe'
    if (Test-NgrokSignature $executable) { return $executable }
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $downloadDirectory = Join-Path $Directory ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $downloadDirectory | Out-Null
    $archive = Join-Path $downloadDirectory 'ngrok.zip'
    $downloaded = Join-Path $downloadDirectory 'ngrok.exe'
    try {
        Write-Host 'Downloading the official portable ngrok helper...'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile $archive
        # Extract only the expected executable, never arbitrary archive paths.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            $entry = $zip.GetEntry('ngrok.exe')
            if (-not $entry) { throw 'The ngrok download contains no executable.' }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $downloaded)
        } finally { $zip.Dispose() }
        if (-not (Test-NgrokSignature $downloaded)) {
            throw 'The helper does not have a valid ngrok publisher signature. It has not been run.'
        }
        Move-Item -LiteralPath $downloaded -Destination $executable -Force
    } finally {
        foreach ($file in @($archive, $downloaded)) {
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
        }
        # This directory was created above and is empty; no recursive deletion.
        Remove-Item -LiteralPath $downloadDirectory
    }
    return $executable
}

function Start-ShareProcess([string]$Executable, [string]$Url, [int]$Port,
                            [Security.SecureString]$Token, [string]$Directory) {
    $configPath = Join-Path $Directory 'ngrok-agent.yml'
    # Keep credentials out of configuration files, command lines, and traffic logs.
    @('version: 3', 'agent:', '  web_addr: false', '  update_check: false', '  remote_management: false') |
        Set-Content -LiteralPath $configPath -Encoding UTF8
    $arguments = @('http', "http://127.0.0.1:$Port", '--url', $Url,
        '--config', "`"$configPath`"", '--inspect=false', '--log', 'stdout', '--log-format', 'json')
    $previousToken = $env:NGROK_AUTHTOKEN
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
    try {
        $env:NGROK_AUTHTOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
        return Start-Process -FilePath $Executable -ArgumentList $arguments -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $Directory 'tunnel.stdout.log') `
            -RedirectStandardError (Join-Path $Directory 'tunnel.stderr.log')
    } finally {
        $env:NGROK_AUTHTOKEN = $previousToken
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
}

function Remove-OwnedPid([string]$Path, [int]$ProcessId) {
    if ((Test-Path -LiteralPath $Path) -and (Get-Content -LiteralPath $Path -Raw).Trim() -eq [string]$ProcessId) {
        Remove-Item -LiteralPath $Path
    }
}

function Watch-ShareProcess([string]$Executable, [hashtable]$Settings, [int]$Port, [string]$Directory) {
    $pidPath = Join-Path $Directory 'tunnel.pid'
    $stopPath = Join-Path $Directory 'share.stop'
    $delay = 2
    while (-not (Test-Path -LiteralPath $stopPath)) {
        $process = $null
        try {
            $process = Start-ShareProcess -Executable $Executable -Url $Settings.url -Port $Port -Token $Settings.token -Directory $Directory
            $process.Id | Set-Content -LiteralPath $pidPath
            $started = [DateTime]::UtcNow
            while (-not $process.HasExited -and -not (Test-Path -LiteralPath $stopPath)) {
                Start-Sleep -Milliseconds 500
                $process.Refresh()
            }
            if (([DateTime]::UtcNow - $started).TotalSeconds -gt 60) { $delay = 2 }
        } finally {
            if ($process) {
                if (-not $process.HasExited) {
                    try { $process.Kill() }
                    catch { if (-not $process.HasExited) { throw } }
                    $process.WaitForExit()
                }
                Remove-OwnedPid -Path $pidPath -ProcessId $process.Id
                $process.Dispose()
            }
        }
        if (Test-Path -LiteralPath $stopPath) { break }
        Write-Host "Sharing stopped. Retrying the same address in $delay seconds."
        Write-Host 'For account/token errors, press Ctrl+C and run share.bat -Setup. Details: .artifacts/tunnel.stderr.log'
        # Short sleeps keep stop-hosting responsive during the retry delay too.
        for ($tick = 0; $tick -lt $delay * 2 -and -not (Test-Path -LiteralPath $stopPath); $tick++) {
            Start-Sleep -Milliseconds 500
        }
        $delay = [Math]::Min(30, $delay * 2)
    }
}

function Start-GolfSharing([string]$Root, [int]$Port = 8000, [switch]$Setup) {
    $directory = Join-Path $Root '.artifacts'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    try {
        $lock = [IO.File]::Open((Join-Path $directory 'share.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch { throw 'Sharing is already running. Use stop-hosting.bat before starting another helper.' }
    $ownerPath = Join-Path $directory 'share.pid'
    $settings = $null
    try {
        $PID | Set-Content -LiteralPath $ownerPath
        $stopPath = Join-Path $directory 'share.stop'
        if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
        $settingsPath = Join-Path $directory 'share-settings.json'
        if ($Setup -or -not (Test-Path -LiteralPath $settingsPath)) { Set-UpSharing $settingsPath }
        if ($Setup) { return }
        $settings = Read-ShareSettings $settingsPath
        $pidPath = Join-Path $directory 'tunnel.pid'
        if (Test-Path -LiteralPath $pidPath) {
            $existing = Get-Process -Id ([int](Get-Content -LiteralPath $pidPath -Raw).Trim()) -ErrorAction SilentlyContinue
            if ($existing -and $existing.Path -in @(
                (Join-Path $directory 'tools\ngrok.exe'), (Join-Path $directory 'tools\cloudflared.exe'))) {
                throw 'A sharing helper is still running. Run stop-hosting.bat before starting sharing again.'
            }
        }
        $executable = Get-NgrokExecutable (Join-Path $directory 'tools')
        Write-Host "Permanent share address: $($settings.url)"
        Write-Host 'Run play.bat too. Open the public address yourself, then host a lobby and copy its invite link.'
        Write-Host 'Keep both windows open. Network outages reconnect automatically; Ctrl+C stops sharing.'
        Write-Host 'After a computer restart, run play.bat and share.bat again to restore this same address.'
        Watch-ShareProcess -Executable $executable -Settings $settings -Port $Port -Directory $directory
    } finally {
        if ($settings -and $settings.token) { $settings.token.Dispose() }
        Remove-OwnedPid -Path $ownerPath -ProcessId $PID
        $lock.Dispose()
    }
}
