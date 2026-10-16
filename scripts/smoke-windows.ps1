# Installs a packed LoomWatch for Windows the way a person does, starts it with loomwatch.cmd, and
# runs the offline demo team through its review stop to the end. CI runs this on a Windows runner;
# nothing in it contacts a model provider.
#
#   scripts\smoke-windows.ps1 -Dist dist -DatabaseUrl postgres://postgres:root@localhost:5432/loomwatch
#
# -Dist is the folder scripts/package-release.sh wrote loomwatch-windows-x86_64.zip and its checksum
# to. GitHub's Windows runners cannot run Docker's Linux database image, so LoomWatch is pointed at
# an existing PostgreSQL with LOOMWATCH_DATABASE_URL, as the launcher allows.
param(
  [Parameter(Mandatory = $true)][string]$Dist,
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [int]$Port = 3300
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repo = Split-Path -Parent $PSScriptRoot
$Dist = (Resolve-Path -LiteralPath $Dist).ProviderPath
$work = Join-Path ([IO.Path]::GetTempPath()) ("loomwatch-smoke-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$app = Join-Path $work 'LoomWatch app'
$teams = Join-Path $work 'teams'
$url = "http://127.0.0.1:$Port"
$failures = 0

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

function Get-Health {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "$url/api/health").Content.Trim() -eq 'ok' } catch { return $false }
}

# The release files and the installer, served over http as GitHub would serve them.
$served = Join-Path $work 'served'
New-Item -ItemType Directory -Force -Path $served | Out-Null
Copy-Item -Path (Join-Path $Dist '*') -Destination $served
Copy-Item -LiteralPath (Join-Path $repo 'scripts\install.ps1') -Destination $served
$python = (Get-Command python -CommandType Application | Select-Object -First 1).Source
$server = Start-Process -FilePath $python -ArgumentList @('-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', "`"$served`"") -PassThru -WindowStyle Hidden
$daemonLog = Join-Path $work 'loomwatch.log'
$launcher = $null
try {
  Wait-Until { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:8765/install.ps1').StatusCode -eq 200 } catch { $false } } 30 'the file server' | Out-Null

  # 1. Install exactly as the README says, in Windows PowerShell 5.1, into a folder with a space.
  $env:LOOMWATCH_DOWNLOAD_BASE = 'http://127.0.0.1:8765'
  $env:LOOMWATCH_APP_DIR = $app
  $env:LOOMWATCH_NO_START = '1'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command 'irm http://127.0.0.1:8765/install.ps1 | iex'
  Check ($LASTEXITCODE -eq 0) 'install.ps1 installs from the release files'
  foreach ($part in @('bin\loomwatchd.exe', 'loomwatch.cmd', 'scripts\loomwatch.ps1', 'install.ps1', 'docker-compose.yml', 'examples\operator-stop.yaml', 'VERSION')) {
    Check (Test-Path -LiteralPath (Join-Path $app $part)) "the install has $part"
  }
  Remove-Item Env:LOOMWATCH_NO_START, Env:LOOMWATCH_APP_DIR, Env:LOOMWATCH_DOWNLOAD_BASE

  $cmd = Join-Path $app 'loomwatch.cmd'
  $help = & cmd.exe /c "`"$cmd`" help" 2>&1 | Out-String
  Check ($LASTEXITCODE -eq 0 -and $help -match 'Usage:') 'loomwatch help prints the usage'
  & cmd.exe /c "`"$cmd`" --no-such-option" 2>&1 | Out-Null
  Check ($LASTEXITCODE -eq 1) 'an unknown option fails with exit code 1'

  # 2. Start it as a person would, with this runner's PostgreSQL instead of Docker's.
  $env:LOOMWATCH_DATABASE_URL = $DatabaseUrl
  $env:LOOMWATCH_TEAMS_ROOT = $teams
  $env:LOOMWATCH_PORT = "$Port"
  $launcher = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"`"$cmd`" --no-open > `"$daemonLog`" 2>&1`"") -PassThru -WindowStyle Hidden
  Wait-Until { Get-Health } 90 'LoomWatch to answer' | Out-Null
  Check $true 'loomwatch.cmd starts LoomWatch'
  Check (Test-Path -LiteralPath (Join-Path $teams 'operator-stop.yaml')) 'the first start puts the offline demo team in the teams folder'
  $about = Invoke-RestMethod -Uri "$url/api/about"
  Check ($about.os -eq 'windows') "LoomWatch reports it runs on $($about.os)"

  # 3. The offline demo: Researcher (Python, found through python3) hands over, the review stop
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

  # 4. Stop it the way a person does, and check it took the apps it ran with it.
  $stop = & cmd.exe /c "`"$cmd`" stop" 2>&1 | Out-String
  Write-Host $stop
  Check ($stop -match 'Stopped LoomWatch') 'loomwatch stop stops LoomWatch'
  Check (-not (Get-Health)) 'LoomWatch no longer answers after loomwatch stop'
} catch {
  Write-Host "FAIL  $($_.Exception.Message)" -ForegroundColor Red
  $failures++
} finally {
  if (Test-Path -LiteralPath $daemonLog) {
    Write-Host '----- LoomWatch output -----'
    Get-Content -LiteralPath $daemonLog | Select-Object -Last 80 | ForEach-Object { Write-Host $_ }
  }
  Get-Process -Name loomwatchd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($launcher -and -not $launcher.HasExited) { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}

if ($failures -gt 0) {
  Write-Host "$failures check(s) failed." -ForegroundColor Red
  exit 1
}
Write-Host 'Every Windows check passed.' -ForegroundColor Green
