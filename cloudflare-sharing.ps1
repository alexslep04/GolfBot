Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

function Get-TunnelHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Get-CloudflaredExecutable([string]$Root) {
    $directory = Join-Path $Root '.artifacts\tools'
    $executable = Join-Path $directory 'cloudflared.exe'
    $expectedHash = '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    if (-not (Test-Path -LiteralPath $executable) -or
        (Get-TunnelHash $executable) -ne $expectedHash) {
        Write-Host 'Downloading the official Cloudflare helper...'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe' -OutFile $executable
    }
    if ((Get-TunnelHash $executable) -ne $expectedHash) {
        throw 'The tunnel helper checksum did not match. It has not been run.'
    }
    return $executable
}

function Write-CloudflareConfig([string]$Root, [int]$Port) {
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid game port.' }
    $directory = Join-Path $Root '.artifacts\cloudflare'
    $credentials = Join-Path $directory 'credentials.json'
    $tunnelId = (Get-Content -LiteralPath $credentials -Raw | ConvertFrom-Json).TunnelID
    if ($tunnelId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'Invalid saved tunnel credentials.' }
    $configuration = Join-Path $directory 'config.yml'
    @(
        "tunnel: $tunnelId",
        "credentials-file: $(ConvertTo-Json -InputObject $credentials -Compress)",
        'ingress:',
        '  - hostname: sleptsov.dev',
        "    path: '^/Golfgame(/.*)?$'",
        "    service: http://127.0.0.1:$Port",
        '  - service: http_status:404'
    ) | Set-Content -LiteralPath $configuration -Encoding UTF8
    return $configuration
}

function Initialize-CloudflareSharing([string]$Root, [string]$Executable, [int]$Port) {
    $directory = Join-Path $Root '.artifacts\cloudflare'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    # cloudflared login always writes its standard user-profile certificate.
    $certificate = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
    $credentials = Join-Path $directory 'credentials.json'
    if (-not (Test-Path -LiteralPath $certificate)) {
        Write-Host 'In the Cloudflare browser window, sign in and authorize sleptsov.dev.'
        & $Executable tunnel login
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $certificate)) { throw 'Cloudflare authorization was not completed.' }
    }
    if (-not (Test-Path -LiteralPath $credentials)) {
        & $Executable tunnel --origincert $certificate create --credentials-file $credentials 'golfbot-sleptsov'
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the Golf tunnel. No existing tunnel was overwritten.' }
    }
    $configuration = Write-CloudflareConfig $Root $Port
    & $Executable tunnel --config $configuration ingress validate
    if ($LASTEXITCODE -ne 0) { throw 'Cloudflare tunnel configuration failed validation.' }
    $tunnelId = (Get-Content -LiteralPath $credentials -Raw | ConvertFrom-Json).TunnelID
    # No --overwrite-dns: never replace a pre-existing website's DNS record.
    & $Executable tunnel --origincert $certificate route dns $tunnelId 'sleptsov.dev'
    if ($LASTEXITCODE -ne 0) { throw 'Could not add the DNS route. Review any existing sleptsov.dev DNS record in Cloudflare; it was not overwritten.' }
    Write-Host 'Setup complete. Start play.bat and share.bat, then open https://sleptsov.dev/Golfgame/'
    Write-Host 'Only /Golfgame and /Golfgame/... are routed to the game. Other paths currently return 404.'
}

function Start-CloudflareProcess([string]$Executable, [string]$ConfigPath, [string]$Directory) {
    return Start-Process -FilePath $Executable -ArgumentList @('tunnel', '--config', "`"$ConfigPath`"", '--no-autoupdate', 'run') `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $Directory 'tunnel.stdout.log') `
        -RedirectStandardError (Join-Path $Directory 'tunnel.stderr.log')
}

function Remove-OwnedPid([string]$Path, [int]$ProcessId) {
    if ((Test-Path -LiteralPath $Path) -and (Get-Content -LiteralPath $Path -Raw).Trim() -eq [string]$ProcessId) {
        Remove-Item -LiteralPath $Path
    }
}

function Watch-CloudflareProcess([string]$Executable, [string]$ConfigPath, [string]$Directory) {
    $pidPath = Join-Path $Directory 'tunnel.pid'
    $stopPath = Join-Path $Directory 'share.stop'
    $delay = 2
    while (-not (Test-Path -LiteralPath $stopPath)) {
        $process = $null
        try {
            $process = Start-CloudflareProcess -Executable $Executable -ConfigPath $ConfigPath -Directory $Directory
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
        Write-Host "Tunnel stopped. Retrying the same sleptsov.dev address in $delay seconds."
        Write-Host 'Connection details: .artifacts/tunnel.stderr.log. Ctrl+C stops retries.'
        for ($tick = 0; $tick -lt $delay * 2 -and -not (Test-Path -LiteralPath $stopPath); $tick++) {
            Start-Sleep -Milliseconds 500
        }
        $delay = [Math]::Min(30, $delay * 2)
    }
}

function Start-GolfSharing([string]$Root, [int]$Port = 8000, [switch]$Setup) {
    $directory = Join-Path $Root '.artifacts'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    try { $lock = [IO.File]::Open((Join-Path $directory 'share.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Sharing is already running. Use stop-hosting.bat before starting another helper.' }
    $ownerPath = Join-Path $directory 'share.pid'
    try {
        $PID | Set-Content -LiteralPath $ownerPath
        $stopPath = Join-Path $directory 'share.stop'
        if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
        $pidPath = Join-Path $directory 'tunnel.pid'
        if (Test-Path -LiteralPath $pidPath) {
            $existing = Get-Process -Id ([int](Get-Content -LiteralPath $pidPath -Raw).Trim()) -ErrorAction SilentlyContinue
            if ($existing -and $existing.Path -eq (Join-Path $directory 'tools\cloudflared.exe')) {
                throw 'A sharing helper is still running. Run stop-hosting.bat before starting sharing again.'
            }
        }
        $executable = Get-CloudflaredExecutable $Root
        if ($Setup) { Initialize-CloudflareSharing $Root $executable $Port; return }
        if (-not (Test-Path -LiteralPath (Join-Path $directory 'cloudflare\credentials.json'))) {
            throw 'Run setup-cloudflare.bat once to authorize sleptsov.dev and create its persistent tunnel.'
        }
        $configuration = Write-CloudflareConfig $Root $Port
        Write-Host 'Game address: https://sleptsov.dev/Golfgame/'
        Write-Host "Run play.bat too (game server port $Port). Keep both windows open."
        Write-Host 'After restarting your computer, run both files again; the address stays the same.'
        Write-Host 'Cloudflare reconnects network outages. This window also retries exited helpers. Ctrl+C stops sharing.'
        Watch-CloudflareProcess -Executable $executable -ConfigPath $configuration -Directory $directory
    } finally {
        Remove-OwnedPid -Path $ownerPath -ProcessId $PID
        $lock.Dispose()
    }
}
