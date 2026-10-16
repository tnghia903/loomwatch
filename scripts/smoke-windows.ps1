# Installs a packed LoomWatch for Windows both ways a person does, and checks each one works:
#
#   1. install.ps1 (irm | iex) into a folder with a space, then loomwatch.cmd: help, version, start,
#      the offline demo team through its review stop to the end, stop, then update to a newer
#      release (made from this one) and roll back from it;
#   2. LoomWatch.exe, the app beside the clock: it starts LoomWatch, a second one starts nothing,
#      and LoomWatch.exe --quit stops both;
#   3. LoomWatch-windows-setup.exe, when -Dist has it: a silent install, its Start menu entry, the
#      installed app starting, and the uninstaller quitting it and removing it.
#
# CI runs this on a Windows runner; nothing in it contacts a model provider.
#
#   scripts\smoke-windows.ps1 -Dist dist
#
# -Dist is the folder scripts/package-release.sh wrote loomwatch-windows-x86_64.zip and its checksum
# to, and scripts/package-windows-app.ps1 the installer.
param(
  [Parameter(Mandatory = $true)][string]$Dist,
  [int]$Port = 3300
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repo = Split-Path -Parent $PSScriptRoot
$Dist = (Resolve-Path -LiteralPath $Dist).ProviderPath
$work = Join-Path ([IO.Path]::GetTempPath()) ("loomwatch smoke " + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$app = Join-Path $work 'LoomWatch app'
$teams = Join-Path $work 'teams'
$failures = 0
# Nothing here changes the runner's own LoomWatch state, or asks GitHub for releases.
$env:LOOMWATCH_STATE_DIR = Join-Path $work 'state'
$env:LOOMWATCH_BACKUP_DIR = Join-Path $work 'backups'
$env:LOOMWATCH_UPDATE_CHECK = 'off'

function Check([bool]$Passed, [string]$What) {
  if ($Passed) { Write-Host "PASS  $What" -ForegroundColor Green }
  else { Write-Host "FAIL  $What" -ForegroundColor Red; $script:failures++ }
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$What) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $value = & $Condition
    if ($value) { return $value }
    Start-Sleep -Milliseconds 500
  }
  throw "timed out after $Seconds s waiting for $What"
}

function Get-Health([int]$On) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$On/api/health").Content.Trim() -eq 'ok' } catch { return $false }
}

function Get-AppProcesses {
  return @(Get-Process -Name LoomWatch -ErrorAction SilentlyContinue)
}

function Show-Log([string]$Title, [string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Write-Host "----- $Title -----"
    Get-Content -LiteralPath $Path | Select-Object -Last 60 | ForEach-Object { Write-Host $_ }
  }
}

# The release files and the installer, served over http as GitHub would serve them.
$served = Join-Path $work 'served'
New-Item -ItemType Directory -Force -Path $served | Out-Null
Copy-Item -Path (Join-Path $Dist '*') -Destination $served
Copy-Item -LiteralPath (Join-Path $repo 'scripts\install.ps1') -Destination $served
$python = (Get-Command python -CommandType Application | Select-Object -First 1).Source
$server = Start-Process -FilePath $python -ArgumentList @('-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', "`"$served`"") -PassThru -WindowStyle Hidden
$daemonLog = Join-Path $work 'loomwatch.log'
$appLog = Join-Path $env:LOOMWATCH_STATE_DIR 'Logs\loomwatchd.log'
$launcher = $null
try {
  Wait-Until { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:8765/install.ps1').StatusCode -eq 200 } catch { $false } } 30 'the file server' | Out-Null

  # --- 1. The terminal way --------------------------------------------------------------------
  # Install exactly as the README says, in Windows PowerShell 5.1, into a folder with a space.
  $env:LOOMWATCH_DOWNLOAD_BASE = 'http://127.0.0.1:8765'
  $env:LOOMWATCH_APP_DIR = $app
  $env:LOOMWATCH_NO_START = '1'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command 'irm http://127.0.0.1:8765/install.ps1 | iex'
  Check ($LASTEXITCODE -eq 0) 'install.ps1 installs from the release files'
  foreach ($part in @('bin\loomwatchd.exe', 'LoomWatch.exe', 'loomwatch.cmd', 'scripts\loomwatch.ps1', 'install.ps1', 'examples\operator-stop.yaml', 'VERSION')) {
    Check (Test-Path -LiteralPath (Join-Path $app $part)) "the install has $part"
  }
  Remove-Item Env:LOOMWATCH_NO_START, Env:LOOMWATCH_APP_DIR, Env:LOOMWATCH_DOWNLOAD_BASE

  $cmd = Join-Path $app 'loomwatch.cmd'
  $help = & cmd.exe /c "`"$cmd`" help" 2>&1 | Out-String
  Check ($LASTEXITCODE -eq 0 -and $help -match 'Usage:' -and $help -match 'rollback') 'loomwatch help prints the usage of a ready-built copy'
  & cmd.exe /c "`"$cmd`" --no-such-option" 2>&1 | Out-Null
  Check ($LASTEXITCODE -eq 1) 'an unknown option fails with exit code 1'
  $version = & cmd.exe /c "`"$cmd`" version" 2>&1 | Out-String
  $packed = ([IO.File]::ReadAllText((Join-Path $app 'VERSION')).Trim() -split ' ')[0]
  Check ($LASTEXITCODE -eq 0 -and $version -match [regex]::Escape("LoomWatch $packed")) "loomwatch version names $packed"

  # Start it as a person would. A copy outside the usual folder keeps its run history in its own.
  $env:LOOMWATCH_TEAMS_ROOT = $teams
  $env:LOOMWATCH_PORT = "$Port"
  $launcher = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"`"$cmd`" --no-open > `"$daemonLog`" 2>&1`"") -PassThru -WindowStyle Hidden
  Wait-Until { Get-Health $Port } 90 'LoomWatch to answer' | Out-Null
  Check $true 'loomwatch.cmd starts LoomWatch'
  Check (Test-Path -LiteralPath (Join-Path $teams 'operator-stop.yaml')) 'the first start puts the offline demo team in the teams folder'
  Check (Test-Path -LiteralPath (Join-Path $app '.loomwatch\loomwatch.db')) 'the run history is one file in the copy''s own folder'
  $url = "http://127.0.0.1:$Port"
  $about = Invoke-RestMethod -Uri "$url/api/about"
  Check ($about.os -eq 'windows') "LoomWatch reports it runs on $($about.os)"
  $apps = Invoke-RestMethod -Uri "$url/api/harnesses"
  Check ($null -ne $apps.harnesses) 'the AI app list answers'

  # The offline demo: Researcher (Python, found through python3) hands over, the review stop
  # waits for an answer, Writer acts on it.
  $started = Invoke-RestMethod -Method Post -Uri "$url/api/runs" -ContentType 'application/json' -Body (@{ teamPath = 'operator-stop.yaml'; prompt = 'Prepare a short getting-started guide for new users.' } | ConvertTo-Json)
  $runId = $started.runId
  Check ([bool]$runId) "the demo run starts ($runId)"
  $waiting = Wait-Until {
    $run = Invoke-RestMethod -Uri "$url/api/runs/$runId"
    if ($run.status -eq 'failed') { throw "the demo run failed: $($run | ConvertTo-Json -Depth 6)" }
    if ($run.PSObject.Properties['waitingOn'] -and $run.waitingOn -and $run.waitingOn.node -eq 'review') { $run }
  } 120 'the demo run to reach its review stop'
  Check ($waiting.waitingOn.node -eq 'review') 'Researcher ran and the run waits at the review stop'
  $answer = @{ node = 'review'; text = 'Approved: write the short guide, with a Windows section.' } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$url/api/runs/$runId/answers" -ContentType 'application/json' -Body $answer | Out-Null
  $finished = Wait-Until {
    $run = Invoke-RestMethod -Uri "$url/api/runs/$runId"
    if ($run.status -in @('succeeded', 'failed', 'cancelled')) { $run }
  } 120 'the demo run to finish'
  Check ($finished.status -eq 'succeeded') "the demo run finishes after the answer ($($finished.status))"
  $reply = [string]$finished.reply
  Check ($reply -match 'Writer received your direction' -and $reply -match 'with a Windows section') "Writer acted on the answer typed at the review stop: $reply"

  # Stop it the way a person does.
  $stop = & cmd.exe /c "`"$cmd`" stop" 2>&1 | Out-String
  Write-Host $stop
  Check ($stop -match 'Stopped LoomWatch') 'loomwatch stop stops LoomWatch'
  Check (-not (Get-Health $Port)) 'LoomWatch no longer answers after loomwatch stop'

  # Update to a "newer" release, this one with another version number, served as GitHub would.
  $next = Join-Path $work 'next'
  Expand-Archive -LiteralPath (Join-Path $served 'loomwatch-windows-x86_64.zip') -DestinationPath $next
  [IO.File]::WriteAllText((Join-Path $next 'loomwatch\VERSION'), "99.0.0 smoke`n")
  $nextServed = Join-Path $served 'v99.0.0'
  New-Item -ItemType Directory -Force -Path $nextServed | Out-Null
  $nextZip = Join-Path $nextServed 'loomwatch-windows-x86_64.zip'
  Compress-Archive -Path (Join-Path $next 'loomwatch') -DestinationPath $nextZip
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nextZip).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText("$nextZip.sha256", "$hash  loomwatch-windows-x86_64.zip`n")
  $env:LOOMWATCH_DOWNLOAD_BASE = 'http://127.0.0.1:8765/v99.0.0'
  $updateLog = Join-Path $work 'update.log'
  # `update` starts the new version in its window when it is done, so it runs in a window of its own.
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"`"$cmd`" update --yes --no-open > `"$updateLog`" 2>&1`"") -WindowStyle Hidden | Out-Null
  Wait-Until { Get-Health $Port } 180 'the updated LoomWatch to answer' | Out-Null
  $now = ([IO.File]::ReadAllText((Join-Path $app 'VERSION')).Trim() -split ' ')[0]
  Check ($now -eq '99.0.0') "loomwatch update installs the newer release ($now)"
  Check (Test-Path -LiteralPath (Join-Path $app '.previous\bin\loomwatchd.exe')) 'and keeps the version it replaced'
  Check (@(Get-ChildItem -LiteralPath $env:LOOMWATCH_BACKUP_DIR -Recurse -Filter 'loomwatch-*.db').Count -eq 1) 'and saved a copy of the run history first'
  Remove-Item Env:LOOMWATCH_DOWNLOAD_BASE
  & cmd.exe /c "`"$cmd`" stop" 2>&1 | Out-Null
  Wait-Until { -not (Get-Health $Port) } 30 'the updated LoomWatch to stop' | Out-Null

  # Go back to the version the update replaced.
  $rollbackLog = Join-Path $work 'rollback.log'
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"`"$cmd`" rollback --yes --no-open > `"$rollbackLog`" 2>&1`"") -WindowStyle Hidden | Out-Null
  Wait-Until { Get-Health $Port } 120 'LoomWatch to answer after rollback' | Out-Null
  $now = ([IO.File]::ReadAllText((Join-Path $app 'VERSION')).Trim() -split ' ')[0]
  Check ($now -eq $packed) "loomwatch rollback puts $packed back ($now)"
  Check (-not (Test-Path -LiteralPath (Join-Path $app '.previous'))) 'and keeps no earlier version afterwards'
  $kept = Invoke-RestMethod -Uri "$url/api/runs/$runId"
  Check ($kept.status -eq 'succeeded') 'the demo run is still in the run history'
  & cmd.exe /c "`"$cmd`" stop" 2>&1 | Out-Null
  Wait-Until { -not (Get-Health $Port) } 30 'LoomWatch to stop after rollback' | Out-Null

  # --- 2. The app beside the clock --------------------------------------------------------------
  $appPort = $Port + 1
  $env:LOOMWATCH_PORT = "$appPort"
  $env:LOOMWATCH_TEAMS_ROOT = Join-Path $work 'app teams'
  $exe = Join-Path $app 'LoomWatch.exe'
  Start-Process -FilePath $exe -ArgumentList '--background' | Out-Null
  Wait-Until { Get-Health $appPort } 90 'LoomWatch.exe to start LoomWatch' | Out-Null
  Check $true 'LoomWatch.exe starts LoomWatch'
  Check (Test-Path -LiteralPath (Join-Path $env:LOOMWATCH_TEAMS_ROOT 'operator-stop.yaml')) 'LoomWatch.exe puts the demo team in a new teams folder'
  Check (Test-Path -LiteralPath (Join-Path $env:LOOMWATCH_STATE_DIR 'loomwatch.db')) 'its run history is in the state folder'
  $second = Start-Process -FilePath $exe -ArgumentList '--background' -PassThru
  Check ($second.WaitForExit(10000)) 'a second LoomWatch.exe ends at once instead of starting another'
  Check (@(Get-AppProcesses).Count -eq 1) 'one LoomWatch.exe runs'
  Check (@(Get-Process -Name loomwatchd -ErrorAction SilentlyContinue).Count -eq 1) 'one loomwatchd runs'
  $quit = Start-Process -FilePath $exe -ArgumentList '--quit' -PassThru
  Check ($quit.WaitForExit(30000)) 'LoomWatch.exe --quit returns'
  Wait-Until { @(Get-AppProcesses).Count -eq 0 -and -not (Get-Health $appPort) } 30 'LoomWatch.exe to quit' | Out-Null
  Check $true 'LoomWatch.exe --quit stops the app and LoomWatch'
  Check ((Get-Content -LiteralPath $appLog -Raw) -match 'stopping too') 'loomwatchd stopped by itself, writing what it held'

  # --- 3. The installer -------------------------------------------------------------------------
  $setup = Join-Path $Dist 'LoomWatch-windows-setup.exe'
  if (Test-Path -LiteralPath $setup) {
    $installed = Join-Path $env:LOCALAPPDATA 'Programs\LoomWatch'
    $installer = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru
    Check ($installer.WaitForExit(180000) -and $installer.ExitCode -eq 0) 'LoomWatch-windows-setup.exe installs silently'
    Check (Test-Path -LiteralPath (Join-Path $installed 'LoomWatch.exe')) 'the installer puts LoomWatch.exe in Programs'
    Check (Test-Path -LiteralPath (Join-Path $installed 'bin\loomwatchd.exe')) 'and loomwatchd.exe beside it'
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'LoomWatch.lnk'
    Check (Test-Path -LiteralPath $menu) 'LoomWatch is in the Start menu'
    Start-Process -FilePath (Join-Path $installed 'LoomWatch.exe') -ArgumentList '--background' | Out-Null
    Wait-Until { Get-Health $appPort } 90 'the installed LoomWatch.exe to start LoomWatch' | Out-Null
    Check $true 'the installed LoomWatch.exe starts LoomWatch'
    # Running the installer again is how LoomWatch updates: it quits the running one first.
    $again = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru
    Check ($again.WaitForExit(180000) -and $again.ExitCode -eq 0) 'installing over a running LoomWatch succeeds'
    Check (@(Get-AppProcesses).Count -eq 0 -and -not (Get-Health $appPort)) 'the installer quit the running LoomWatch first'
    Start-Process -FilePath (Join-Path $installed 'LoomWatch.exe') -ArgumentList '--background' | Out-Null
    Wait-Until { Get-Health $appPort } 90 'LoomWatch.exe to start after the update' | Out-Null
    $uninstaller = Join-Path $installed 'unins000.exe'
    $removed = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru
    Check ($removed.WaitForExit(120000)) 'the uninstaller finishes'
    Wait-Until { -not (Test-Path -LiteralPath (Join-Path $installed 'LoomWatch.exe')) } 60 'the uninstaller to remove LoomWatch' | Out-Null
    Check (@(Get-AppProcesses).Count -eq 0 -and -not (Get-Health $appPort)) 'removing LoomWatch quits it first'
    Check (-not (Test-Path -LiteralPath $menu)) 'and takes it off the Start menu'
    Check (Test-Path -LiteralPath (Join-Path $env:LOOMWATCH_STATE_DIR 'loomwatch.db')) 'the run history stays after LoomWatch is removed'
  } else {
    Write-Host "SKIP  no LoomWatch-windows-setup.exe in $Dist"
  }
} catch {
  Write-Host "FAIL  $($_.Exception.Message)" -ForegroundColor Red
  $failures++
} finally {
  Show-Log 'loomwatch.cmd output' $daemonLog
  Show-Log 'loomwatch update output' (Join-Path $work 'update.log')
  Show-Log 'loomwatch rollback output' (Join-Path $work 'rollback.log')
  Show-Log 'LoomWatch.exe log' $appLog
  Get-AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process -Name loomwatchd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($launcher -and -not $launcher.HasExited) { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}

if ($failures -gt 0) {
  Write-Host "$failures check(s) failed." -ForegroundColor Red
  exit 1
}
Write-Host 'Every Windows check passed.' -ForegroundColor Green
