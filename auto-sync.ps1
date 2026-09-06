$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $workspace

Write-Host "========================================" -ForegroundColor Green
Write-Host " AUTO-SYNC: Watching for file changes..." -ForegroundColor Green
Write-Host " Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Green

# Debounce: wait 2s after last change before committing
$debounceSeconds = 2
$lastChange = $null
$timer = [System.Diagnostics.Stopwatch]::StartNew()

# Files/folders to ignore
$ignorePatterns = @(
    'node_modules',
    '.git',
    'tmp_images',
    'data',
    'upload_v2',
    'upload_v3',
    'cloudflare-worker\temp_out',
    '*.zip',
    'auto_sync_test.txt'
)

function Should-Ignore($path) {
    $relative = $path.Replace($workspace + "\", "")
    foreach ($pattern in $ignorePatterns) {
        if ($relative -like $pattern -or $relative.StartsWith($pattern)) {
            return $true
        }
    }
    return $false
}

function Get-GitToken {
    $input = "protocol=https`nhost=github.com`n"
    $output = echo $input | git credential fill 2>&1
    foreach ($line in $output) {
        if ($line -match "^password=(.+)$") { return $Matches[1] }
    }
    return $null
}

function Do-Sync {
    Set-Location $workspace
    $env:GIT_TERMINAL_PROMPT = "0"
    
    $status = git status --porcelain 2>&1
    if (-not $status) {
        return
    }

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Changes detected, committing..." -ForegroundColor Cyan
    
    git add -A 2>&1 | Out-Null
    
    $changed = git diff --cached --name-only 2>&1
    $fileCount = ($changed | Measure-Object).Count
    $summary = if ($fileCount -le 3) { $changed -join ", " } else { "$fileCount files" }
    
    git commit -m "auto: $summary" 2>&1 | Out-Null
    
    # Get token from credential manager for non-interactive push
    $token = Get-GitToken
    $remoteUrl = git remote get-url origin 2>&1
    if ($token -and $remoteUrl -notmatch "ghp_|gho_") {
        $secureUrl = $remoteUrl -replace "https://", "https://abubackerfayaz-ops:${token}@"
        git remote set-url origin $secureUrl
    }
    
    $pushOutput = git push origin main 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Pushed: $summary" -ForegroundColor Green
    } else {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Push failed, retrying next change" -ForegroundColor Red
    }
    
    # Clean up remote URL (remove token)
    git remote set-url origin https://github.com/abubackerfayaz-ops/jerzees.git
}

# Watch all important file types
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $workspace
$watcher.IncludeSubdirectories = $true
$watcher.Filter = "*.*"
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::Size
$watcher.EnableRaisingEvents = $true

$action = {
    $path = $Event.SourceEventArgs.FullPath
    $name = $Event.SourceEventArgs.Name
    
    # Check ignore patterns
    $relative = $path.Replace((Get-Location).Path + "\", "")
    $ignore = $false
    $ignoreParts = @('node_modules', '.git', 'tmp_images', 'data', 'upload_v2', 'upload_v3', 'temp_out')
    foreach ($part in $ignoreParts) {
        if ($relative -like "*$part*") { $ignore = $true; break }
    }
    if ($name -like "*.zip" -or $name -like "*.log") { $ignore = $true }
    
    if (-not $ignore) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Changed: $name" -ForegroundColor Yellow
        $global:lastChange = [System.Diagnostics.Stopwatch]::StartNew()
    }
}

Register-ObjectEvent $watcher "Changed" -Action $action
Register-ObjectEvent $watcher "Created" -Action $action
Register-ObjectEvent $watcher "Deleted" -Action $action
Register-ObjectEvent $watcher "Renamed" -Action $action

Write-Host "File watcher started. Watching: $workspace" -ForegroundColor Cyan
Write-Host ""

# Main loop - check for pending sync every second
try {
    while ($true) {
        Start-Sleep -Seconds 1
        if ($global:lastChange -and $global:lastChange.Elapsed.TotalSeconds -ge $debounceSeconds) {
            Do-Sync
            $global:lastChange = $null
        }
    }
} finally {
    $watcher.Dispose()
    Write-Host "Auto-sync stopped." -ForegroundColor Yellow
}
