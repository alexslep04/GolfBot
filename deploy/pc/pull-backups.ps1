<#
Copy the Golf server's daily backups from the Raspberry Pi to this PC.

    .\pull-backups.ps1 -Pi pi@raspberrypi.local            # copy what is missing, now
    .\pull-backups.ps1 -Pi pi@raspberrypi.local -Install   # and do it every day from now on

The Pi writes one archive a day to ~/golf-backups (deploy/pi/backup.sh). This
copies every archive the PC does not have yet, so days when the PC was off are
caught up on the next run. Each copy is opened and checked before it is kept.
The PC keeps the newest -Keep archives and one a month beyond that.

It signs in to the Pi with an SSH key, never a password (docs/raspberry-pi.md, step 6).
-Install copies this script into the backup folder and registers the scheduled
task "Golf backups" there, so it does not depend on any Git checkout.
#>
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[\w.-]+@[\w.-]+$')][string]$Pi,
    [string]$To = (Join-Path $env:USERPROFILE 'GolfBackups'),
    [ValidatePattern('^[\w./~-]+$')][string]$From = 'golf-backups',
    [ValidateRange(1, 10000)][int]$Keep = 60,
    # complain when the newest archive is older than this many days: the Pi's own backup has stopped
    [ValidateRange(1, 365)][int]$StaleDays = 2,
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
$pattern = '^golf-(\d{8})-(\d{6})\.tar\.gz$'
New-Item -ItemType Directory -Path $To -Force | Out-Null
$logFile = Join-Path $To 'pull.log'

function Write-Log([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Write-Host $line
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

if ($Install) {
    $script = Join-Path $To 'pull-backups.ps1'
    if ($PSCommandPath -ne $script) { Copy-Item -LiteralPath $PSCommandPath -Destination $script -Force }
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Pi $Pi -To `"$To`" -From $From -Keep $Keep -StaleDays $StaleDays"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
    # Daily, after the Pi's own 04:30 backup. If the PC was off or asleep then, it runs when it is next on.
    $trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName 'Golf backups' -Action $action -Trigger $trigger -Settings $settings `
        -Description "Copies the Golf server's daily backups from $Pi to $To" -Force | Out-Null
    Write-Log "Installed the scheduled task 'Golf backups' (daily at 09:00, or when the PC is next on). Running it once now."
}

function Invoke-Pi([string]$Command) {
    # BatchMode: fail at once instead of waiting for a password nobody will type
    $output = & ssh -o BatchMode=yes -o ConnectTimeout=20 $Pi $Command
    if ($LASTEXITCODE -ne 0) { throw "Could not reach $Pi over SSH (exit $LASTEXITCODE). Is the Pi on, and is this PC's SSH key installed on it?" }
    return @($output)
}

function Test-Archive([string]$Path) {
    # it must open as a gzip'd tar and hold the database
    $ErrorActionPreference = 'Continue'  # (tar's complaints about a bad file are an answer, not a crash)
    # (Windows' own tar by its full path: another tar on PATH may read "C:" as a remote host)
    $names = & (Join-Path $env:SystemRoot 'System32\tar.exe') -tzf $Path 2>$null
    return ($LASTEXITCODE -eq 0) -and (@($names) -contains 'matches.sqlite3')
}

try {
    $remote = @(Invoke-Pi "ls -1 $From") | Where-Object { $_ -match $pattern } | Sort-Object
    if (-not $remote) { throw "There are no backups in ${Pi}:$From yet. On the Pi: sudo systemctl start golf-backup" }
    Get-ChildItem -LiteralPath $To -File -Filter '*.partial' | Remove-Item -Force  # (left by a run that was cut off)
    # everything newer than what is here: the names sort by date, and copies are made oldest first,
    # so a run that stops part-way is picked up from the same place next time
    $newestHere = Get-ChildItem -LiteralPath $To -File | Where-Object { $_.Name -match $pattern } | Sort-Object Name | Select-Object -Last 1
    $missing = @($remote | Where-Object { -not $newestHere -or $_ -gt $newestHere.Name })
    $copied = 0
    foreach ($name in $missing) {
        $partial = Join-Path $To "$name.partial"
        & scp -q -o BatchMode=yes -o ConnectTimeout=20 "${Pi}:$From/$name" $partial
        if ($LASTEXITCODE -ne 0) { throw "Copying $name failed (exit $LASTEXITCODE)." }
        if (-not (Test-Archive $partial)) {
            Remove-Item -LiteralPath $partial -Force
            throw "$name did not arrive as a readable archive; it was not kept."
        }
        Move-Item -LiteralPath $partial -Destination (Join-Path $To $name) -Force
        $copied++
    }

    # thin out: the newest $Keep, and the first archive of every month
    $all = @(Get-ChildItem -LiteralPath $To -File | Where-Object { $_.Name -match $pattern } | Sort-Object Name)
    $wanted = @{}
    $all | Select-Object -Last $Keep | ForEach-Object { $wanted[$_.Name] = $true }
    $all | Group-Object { $_.Name.Substring(5, 6) } | ForEach-Object { $wanted[($_.Group | Select-Object -First 1).Name] = $true }
    $removed = @($all | Where-Object { -not $wanted.ContainsKey($_.Name) })
    $removed | Remove-Item -Force

    $newest = ($all | Select-Object -Last 1).Name
    $null = $newest -match $pattern
    $age = (Get-Date) - [datetime]::ParseExact($Matches[1] + $Matches[2], 'yyyyMMddHHmmss', $null)
    Write-Log "Copied $copied new, $($all.Count - $removed.Count) kept, $($removed.Count) old removed. Newest: $newest"
    if ($age.TotalDays -gt $StaleDays) {
        throw "The newest backup is $([math]::Floor($age.TotalDays)) days old: the Pi has stopped making them. On the Pi: journalctl -u golf-backup -n 40"
    }
} catch {
    Write-Log "FAILED: $($_.Exception.Message)"
    exit 1
}
