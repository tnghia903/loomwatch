# One command to set up, build, start, update and stop LoomWatch on Windows: the Windows twin of
# the ./loomwatch script, run through loomwatch.cmd.
#
#   loomwatch            set up anything missing, build if the code changed, start, open the browser
#   loomwatch update     save a copy of the run history, download the latest version, and start
#   loomwatch rollback   go back to the version the last update replaced (ready-built copies)
#   loomwatch version    say which version this is, and whether a newer one is out
#   loomwatch stop       stop LoomWatch (your teams and history are kept)
#
# The same script runs a copy of the source code, which it builds, and a ready-built copy put in
# %USERPROFILE%\LoomWatch\app by install.ps1, which carries its program in bin\ and updates from the
# newest release instead of from Git. A ready-built copy can also be updated from the app, with
# Update and restart: LoomWatch stops, this script updates it as `update` does, and starts it again
# in the same window.
#
# LoomWatch keeps its run history in one file, and needs nothing else installed to start.
#
# Optional settings, read from the environment:
#   LOOMWATCH_TEAMS_ROOT    where your teams live (default: ~\LoomWatch\teams)
#   LOOMWATCH_PORT          browser port (default: LOOMWATCH_PORT in .env, else 3000)
#   LOOMWATCH_DATABASE      the file that holds the run history
#   LOOMWATCH_BACKUP_DIR    where updates keep copies of the run history (default: ~\LoomWatch\backups)
#   LOOMWATCH_UPDATE_CHECK  off: never ask GitHub whether a newer version is out
#
# Written for the Windows PowerShell 5.1 every Windows 10 and 11 computer has, and kept to ASCII:
# Windows PowerShell reads a script without a byte-order mark in the local code page.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Started from PowerShell 7 (through loomwatch.cmd, say), Windows PowerShell inherits PowerShell 7's
# module folders first, and then lacks commands of its own, such as Get-FileHash. Its own come
# first again; PowerShell 7 itself is left as it is.
if ($PSVersionTable.PSEdition -eq 'Desktop' -and $env:PSModulePath) {
  $own = Join-Path $PSHOME 'Modules'
  $folders = @($env:PSModulePath -split ';' | Where-Object { $_ -and $_ -notmatch '[\\/]PowerShell[\\/]' })
  if (-not ($folders -contains $own)) { $folders += $own }
  $env:PSModulePath = $folders -join ';'
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot
$HomeFolder = [Environment]::GetFolderPath('UserProfile')
$Cmd = Join-Path $RepoRoot 'loomwatch.cmd'

# This script as the operator would type it again, for the instructions it prints: loomwatch when
# its folder is on PATH (as install.ps1 arranges), .\loomwatch.cmd in a copy of the source.
$Self = '.\loomwatch.cmd'
$OnPath = Get-Command loomwatch -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($OnPath -and ($OnPath.Source -eq $Cmd)) { $Self = 'loomwatch' }
elseif (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'Cargo.toml'))) { $Self = "& '$Cmd'" }

$script:FailureHeading = 'LoomWatch could not start'
# Set while an update asked for in the app runs: the LoomWatch started again after it says why the
# update did not finish.
$script:FailureNote = $null
function Say([string]$Text) { Write-Host $Text }
function Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) {
  Write-Host ''
  Write-Host "$($script:FailureHeading): $Text" -ForegroundColor Red
  if ($script:FailureNote) {
    $why = $Text.Replace('The messages above say why.', 'The window running LoomWatch says why.')
    try { [IO.File]::WriteAllText($script:FailureNote, $why) } catch { }
    throw 'update failed'
  }
  exit 1
}

# A path as the operator would type it, with ~ for the home folder: shorter, and a pasted log no
# longer shows the account name.
function Pretty([string]$Path) {
  if ($Path.StartsWith($HomeFolder + '\', [StringComparison]::OrdinalIgnoreCase)) {
    return '~' + $Path.Substring($HomeFolder.Length)
  }
  return $Path
}

# rustup installs outside the PATH a terminal opened before it may have. Appended, so the
# operator's own ordering still wins.
$cargoBin = Join-Path $HomeFolder '.cargo\bin'
if ((Test-Path -LiteralPath $cargoBin) -and -not (($env:Path -split ';') -contains $cargoBin)) {
  $env:Path = "$env:Path;$cargoBin"
}

$Command = 'start'
$OpenBrowser = $true
$ForceRebuild = $false
$BackUp = $true
$AssumeYes = $false
foreach ($arg in $args) {
  switch -Exact ($arg) {
    'start' { $Command = 'start' }
    'update' { $Command = 'update' }
    'rollback' { $Command = 'rollback' }
    'stop' { $Command = 'stop' }
    'version' { $Command = 'version' }
    '--version' { $Command = 'version' }
    'help' { $Command = 'help' }
    '-h' { $Command = 'help' }
    '--help' { $Command = 'help' }
    '/?' { $Command = 'help' }
    '--no-open' { $OpenBrowser = $false }
    '--rebuild' { $ForceRebuild = $true }
    '--no-backup' { $BackUp = $false }
    '--yes' { $AssumeYes = $true }
    '-y' { $AssumeYes = $true }
    default {
      $script:FailureHeading = 'LoomWatch'
      Fail "unknown option '$arg'. Run $Self help to see the options."
    }
  }
}

$TeamsRoot = $env:LOOMWATCH_TEAMS_ROOT
if (-not $TeamsRoot) { $TeamsRoot = Join-Path $HomeFolder 'LoomWatch\teams' }
$BackupRoot = $env:LOOMWATCH_BACKUP_DIR
if (-not $BackupRoot) { $BackupRoot = Join-Path $HomeFolder 'LoomWatch\backups' }
# A ready-built copy has its program in bin\ and no source code to build it from.
if ((Test-Path -LiteralPath (Join-Path $RepoRoot 'bin\loomwatchd.exe')) -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot 'Cargo.toml'))) {
  $Prebuilt = $true
  $Binary = Join-Path $RepoRoot 'bin\loomwatchd.exe'
  $StateDir = Join-Path $RepoRoot 'run'
} else {
  $Prebuilt = $false
  $Binary = Join-Path $RepoRoot 'target\release\loomwatchd.exe'
  $StateDir = Join-Path $RepoRoot 'target'
}
$BuildStamp = Join-Path $RepoRoot 'target\release\.loomwatch-build'
$PidFile = Join-Path $StateDir 'loomwatchd.pid'
# The exit status LoomWatch asks for an update with (EX_TEMPFAIL), and where it names the release.
$UpdateExitCode = 75
$UpdateRequest = Join-Path $StateDir 'update-request'
$UpdateFailed = Join-Path $StateDir 'update-failed'

# The run history is one file. The ready-built copy in the usual folder keeps it where the program
# keeps it by default, in LoomWatch's state folder (%LOCALAPPDATA%\LoomWatch), so it outlives
# reinstalling. Every other copy, a copy of the source or a release being tried, keeps its own in
# its folder: two copies never share one.
$UsualApp = Join-Path $HomeFolder 'LoomWatch\app'
if (-not $env:LOOMWATCH_DATABASE -and (-not $Prebuilt -or -not $RepoRoot.Equals($UsualApp, [StringComparison]::OrdinalIgnoreCase))) {
  $env:LOOMWATCH_DATABASE = Join-Path $RepoRoot '.loomwatch\loomwatch.db'
}

# Someone running a copy of the source is in its folder; someone running a ready-built copy may be
# anywhere, so instructions name that copy's files in full.
function WhereIs([string]$Name) {
  if ($Prebuilt) { return Join-Path (Pretty $RepoRoot) $Name }
  return $Name
}

# One argument as Windows programs read their command line (CommandLineToArgvW): quoted when it
# has spaces or quotes, with quotes and the backslashes before them escaped.
function ConvertTo-Argument([string]$Value) {
  if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', { param($m) $m.Groups[1].Value + $m.Groups[1].Value + '\"' })
  $escaped = [regex]::Replace($escaped, '(\\+)$', { param($m) $m.Groups[1].Value + $m.Groups[1].Value })
  return '"' + $escaped + '"'
}

# Runs a program and returns its exit code and what it printed, with every argument passed exactly
# as given: Windows PowerShell drops the quotes inside arguments it passes to a program itself.
function Invoke-Tool([string]$File, [string[]]$Arguments, [string]$InputText) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $File
  $info.Arguments = (@($Arguments) | ForEach-Object { ConvertTo-Argument $_ }) -join ' '
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.RedirectStandardInput = $true
  $info.WorkingDirectory = $RepoRoot
  try {
    $process = [System.Diagnostics.Process]::Start($info)
  } catch {
    return [pscustomobject]@{ ExitCode = -1; Out = ''; Err = $_.Exception.Message }
  }
  $out = $process.StandardOutput.ReadToEndAsync()
  $err = $process.StandardError.ReadToEndAsync()
  if ($InputText) { $process.StandardInput.Write($InputText.Replace("`r`n", "`n")) }
  $process.StandardInput.Close()
  $process.WaitForExit()
  return [pscustomobject]@{ ExitCode = $process.ExitCode; Out = $out.Result; Err = $err.Result }
}

# Runs a program in this window, its output shown as it comes, and returns its exit code. Windows
# PowerShell turns what a program writes to stderr into errors when this window's output is
# redirected; those are the program's own progress messages, and its exit code says whether it
# failed.
function Invoke-Native([string]$File, [string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  & $File @Arguments | Out-Host
  return $LASTEXITCODE
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Write-TextFile([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [IO.File]::WriteAllText($Path, $Text)
}

# The last KEY=value line for KEY in .env, without surrounding quotes. .env is read, never run.
function EnvValue([string]$Key) {
  $file = Join-Path $RepoRoot '.env'
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  $value = ''
  foreach ($line in [IO.File]::ReadAllLines($file)) {
    if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1).Trim() }
  }
  if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

$Port = $env:LOOMWATCH_PORT
if (-not $Port) { $Port = EnvValue 'LOOMWATCH_PORT' }
if (-not $Port) { $Port = '3000' }
$Url = "http://127.0.0.1:$Port"

# Straight to this computer: a system proxy must not answer for 127.0.0.1.
$WebOptions = @{ UseBasicParsing = $true; TimeoutSec = 2 }
if ($PSVersionTable.PSVersion.Major -ge 6) { $WebOptions['NoProxy'] = $true }
else { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy }

function Test-PortInUse([int]$Number) {
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    return [bool](Get-NetTCPConnection -LocalPort $Number -State Listen -ErrorAction SilentlyContinue)
  }
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Number)
  try { $listener.Start(); $listener.Stop(); return $false } catch { return $true }
}

function Test-LoomWatchRunning {
  try {
    $response = Invoke-WebRequest @WebOptions -Uri "$Url/api/health"
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
    return ([string]$content).Trim() -eq 'ok'
  } catch {
    return $false
  }
}

# The process listening on a port, or nothing.
function Get-ListenerPid([int]$Number) {
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return $null }
  $connection = Get-NetTCPConnection -LocalPort $Number -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($connection) { return [int]$connection.OwningProcess }
  return $null
}

# The program a process was started from, or nothing when Windows will not say.
function Get-ProcessProgram([int]$Id) {
  $process = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  try { return $process.Path } catch { return $null }
}

function Open-Url([string]$Address) {
  if ($OpenBrowser) { Start-Process $Address }
}

# A LoomWatch answering on the port is only this one when it was started from this folder. Another
# copy, LoomWatch.exe among them, holds the port with its own files.
function Confirm-AlreadyRunning {
  $other = Get-ListenerPid $Port
  if ($other) {
    $program = Get-ProcessProgram $other
    if ($program -and -not $program.Equals($Binary, [StringComparison]::OrdinalIgnoreCase)) {
      Fail "another copy of LoomWatch is already running at $Url (process $other, $program). Quit it (LoomWatch beside the clock: Quit LoomWatch), or stop it with: Stop-Process -Id $other
Then run $Self again. To keep it running, start this copy on another port instead: `$env:LOOMWATCH_PORT=$([int]$Port + 1); $Self"
    }
  }
  Say "LoomWatch is already running at $Url"
  Open-Url $Url
  exit 0
}

# Every missing tool in one list, so nobody fixes one, reruns, and only then meets the next.
function Assert-Prerequisites {
  $missing = New-Object System.Collections.Generic.List[string]
  $winget = Test-Command winget

  # Only a copy of the source code is built here; a ready-built copy needs neither Node.js nor Rust.
  if (-not $Prebuilt) {
    if (-not (Test-Command node)) {
      if ($winget) { $missing.Add('  - Node.js 22 or newer, which builds the browser app: winget install OpenJS.NodeJS.LTS') }
      else { $missing.Add('  - Node.js 22 or newer, which builds the browser app: https://nodejs.org/') }
    } else {
      $check = Invoke-Tool node @('-e', 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)')
      if ($check.ExitCode -ne 0) {
        $missing.Add("  - A newer Node.js: LoomWatch needs 22.12 or newer and this computer has $((Invoke-Tool node @('--version')).Out.Trim()).
    Install the current version from https://nodejs.org/")
      }
    }
    if (-not (Test-Command cargo)) {
      if ($winget) { $missing.Add('  - Rust, which builds the LoomWatch program: winget install Rustlang.Rustup') }
      else { $missing.Add('  - Rust, which builds the LoomWatch program: https://rustup.rs/') }
    }
  }

  if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host 'LoomWatch needs a few things installed first:' -ForegroundColor Yellow
    foreach ($line in $missing) { Write-Host $line }
    Write-Host ''
    Say "When they are installed, open a new terminal window and run $Self again."
    exit 1
  }
}

function Initialize-TeamsRoot {
  if (Test-Path -LiteralPath $TeamsRoot) { return }
  New-Item -ItemType Directory -Force -Path $TeamsRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'examples\operator-stop.yaml') -Destination $TeamsRoot
  Say "Created your teams folder at $(Pretty $TeamsRoot), with an offline demo team in it."
}

function Get-Hash([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
  }
}

# What the build depends on: the commit plus any local edits. An unchanged checkout never rebuilds.
function Get-SourceFingerprint {
  if (-not (Test-Command git) -or (Invoke-Tool git @('rev-parse', '--git-dir')).ExitCode -ne 0) { return 'unversioned' }
  $paths = @('ui', 'crates', 'migrations', 'schemas', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml')
  $text = (Invoke-Tool git @('rev-parse', 'HEAD')).Out
  $text += (Invoke-Tool git (@('status', '--porcelain', '--') + $paths)).Out
  $text += (Invoke-Tool git (@('diff', 'HEAD', '--') + $paths)).Out
  return Get-Hash $text
}

function Invoke-BuildIfNeeded {
  if ($Prebuilt) { return }
  $fingerprint = Get-SourceFingerprint
  $stamp = ''
  if (Test-Path -LiteralPath $BuildStamp) { $stamp = ([IO.File]::ReadAllText($BuildStamp)).Trim() }
  if (-not $ForceRebuild -and (Test-Path -LiteralPath $Binary) -and $stamp -eq $fingerprint) { return }
  Step 'Building LoomWatch (the first build takes a few minutes)'
  # The browser app is built first: it is packed into the LoomWatch program.
  Push-Location -LiteralPath (Join-Path $RepoRoot 'ui')
  try {
    $built = Invoke-Native npx @('--yes', 'pnpm@12', 'install', '--frozen-lockfile')
    if ($built -eq 0) { $built = Invoke-Native npx @('--yes', 'pnpm@12', 'run', 'build') }
    if ($built -ne 0) { Fail 'the browser app did not build. The messages above say why.' }
  } finally {
    Pop-Location
  }
  if ((Invoke-Native cargo @('build', '--release', '--locked', '--bin', 'loomwatchd')) -ne 0) {
    Fail 'the LoomWatch program did not build. The messages above say why.'
  }
  Write-TextFile $BuildStamp "$fingerprint`n"
}

# The file that holds the run history, as the program resolves it. Needs the program built.
function Get-DatabaseFile {
  $result = Invoke-Tool $Binary @('database-path')
  if ($result.ExitCode -ne 0 -or -not $result.Out.Trim()) {
    Fail 'LoomWatch could not say where it keeps the run history. The messages above say why.'
  }
  return $result.Out.Trim()
}

# Which checkout is running, for the "Send feedback" report. `-dirty` marks local edits. A
# ready-built copy names the commit its release was built from, in VERSION.
function Get-Commit {
  if ($Prebuilt) {
    $versionFile = Join-Path $RepoRoot 'VERSION'
    if (Test-Path -LiteralPath $versionFile) {
      $fields = ([IO.File]::ReadAllText($versionFile)).Trim().Split(' ')
      if ($fields.Count -gt 1) { return $fields[1] }
    }
    return ''
  }
  if (Test-Command git) { return (Invoke-Tool git @('describe', '--always', '--dirty', '--abbrev=7')).Out.Trim() }
  return ''
}

# Starts LoomWatch in this window and waits for it to stop, opening the browser once it answers
# (unless $Open is false). Returns its exit code. It shares this window, so Ctrl+C reaches it
# exactly as if it had been started by hand.
function Invoke-Daemon([bool]$Open) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Binary
  $info.Arguments = (@('serve', '--teams-root', $TeamsRoot, '--listen', "127.0.0.1:$Port") | ForEach-Object { ConvertTo-Argument $_ }) -join ' '
  $info.UseShellExecute = $false
  $info.WorkingDirectory = $RepoRoot
  $daemon = [System.Diagnostics.Process]::Start($info)
  Write-TextFile $PidFile "$($daemon.Id)`n"
  try {
    $opened = -not $Open
    for ($tick = 0; -not $daemon.HasExited; $tick++) {
      if (-not $opened -and $tick -lt 240 -and (Test-LoomWatchRunning)) {
        Open-Url $Url
        $opened = $true
      }
      Start-Sleep -Milliseconds 500
    }
  } finally {
    if (-not $daemon.HasExited) { [void]$daemon.WaitForExit(5000) }
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  }
  return $daemon.ExitCode
}

function Start-LoomWatch {
  if (Test-LoomWatchRunning) { Confirm-AlreadyRunning }
  if (Test-PortInUse $Port) {
    Fail "another program is using port $Port. Start LoomWatch on a different port with: `$env:LOOMWATCH_PORT=$([int]$Port + 1); $Self"
  }

  Assert-Prerequisites
  Initialize-TeamsRoot
  Invoke-BuildIfNeeded
  $database = Get-DatabaseFile

  # The update hand-over is set below, for a ready-built copy only: a daemon told about one that
  # nothing is running would stop and stay stopped.
  foreach ($name in @('LOOMWATCH_SUPERVISED', 'LOOMWATCH_UPDATE_REQUEST', 'LOOMWATCH_UPDATE_FAILED')) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  }
  $env:LOOMWATCH_COMMIT = Get-Commit
  # How this copy is updated, for the app's notice that a newer version is out (ADR 0052).
  if ($Prebuilt) { $env:LOOMWATCH_INSTALL = 'release' } else { $env:LOOMWATCH_INSTALL = 'source' }
  $env:LOOMWATCH_UPDATE_COMMAND = "$Self update"

  Step "LoomWatch is starting at $Url"
  Say "Your teams are in $(Pretty $TeamsRoot)"
  Say "Your run history is in $(Pretty $database)"
  Say 'Keep this window open while you use LoomWatch. Press Ctrl+C to stop it.'
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  if ($Prebuilt) { Invoke-Supervised }
  exit (Invoke-Daemon $OpenBrowser)
}

function Stop-LoomWatch {
  $script:FailureHeading = 'LoomWatch could not stop'
  $stopped = $false
  if (Test-Path -LiteralPath $PidFile) {
    $id = 0
    [void][int]::TryParse(([IO.File]::ReadAllText($PidFile)).Trim(), [ref]$id)
    $process = $null
    if ($id -gt 0) { $process = Get-Process -Id $id -ErrorAction SilentlyContinue }
    if ($process -and $process.ProcessName -eq 'loomwatchd') {
      # Windows has no Ctrl+C to send another window's program; ending it ends every app it ran,
      # each of which LoomWatch keeps in a job that closes with it. Its run history stays whole:
      # at most the last moment of what was running is not recorded.
      Stop-Process -Id $id -Force
      if (-not $process.WaitForExit(10000)) { Fail "LoomWatch (process $id) is still running. Stop it in Task Manager." }
      $stopped = $true
      Say 'Stopped LoomWatch. Your teams and history are kept.'
    }
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  }
  if (-not $stopped -and (Test-LoomWatchRunning)) {
    $other = Get-ListenerPid $Port
    if ($other) {
      Say "LoomWatch at $Url was not started by $Self in this folder. It is process $other, from $(Get-ProcessProgram $other). Quit it from its icon beside the clock, press Ctrl+C in the window running it, or run: Stop-Process -Id $other"
    } else {
      Say "LoomWatch at $Url was not started by $Self. Press Ctrl+C in the window running it."
    }
  }
}

# --- Updating (ADR 0052) -------------------------------------------------------------------------
# An update never starts by itself: the app only says a newer version is out. `update` saves a copy
# of the run history before anything can change it, and in a ready-built copy keeps the version it
# replaces in .previous, so `rollback` can put it back.

# The version this copy runs: VERSION's first word in a ready-built copy, the program's own in a
# copy of the source.
function Get-InstalledVersion {
  if ($Prebuilt) {
    $file = Join-Path $RepoRoot 'VERSION'
    if (Test-Path -LiteralPath $file) { return ([IO.File]::ReadAllText($file).Trim() -split ' ')[0] }
    return ''
  }
  $manifest = Join-Path $RepoRoot 'crates\loomwatch-backend\Cargo.toml'
  foreach ($line in [IO.File]::ReadAllLines($manifest)) {
    if ($line -match '^version = "(.*)"$') { return $Matches[1] }
  }
  return ''
}

# MAJOR.MINOR.PATCH of a version such as v0.5.1-rc.1, or nothing when it is not one.
function ConvertTo-Version([string]$Text) {
  $core = $Text.TrimStart('v') -replace '[-+].*$', ''
  if ($core -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { return $null }
  return [version]$core
}

# True when version $A is newer than $B. Anything that is not a version is never newer.
function Test-Newer([string]$A, [string]$B) {
  $left = ConvertTo-Version $A
  $right = ConvertTo-Version $B
  if (-not $left -or -not $right) { return $false }
  return $left -gt $right
}

function Test-UpdateCheckOff {
  return @('0', 'off', 'false', 'no') -contains ([string]$env:LOOMWATCH_UPDATE_CHECK).ToLowerInvariant()
}

# The newest published release, such as v0.5.0, or nothing when GitHub cannot be asked, and for a
# trial of files served from elsewhere (LOOMWATCH_DOWNLOAD_BASE), which say nothing about GitHub.
function Get-LatestRelease {
  if ($env:LOOMWATCH_DOWNLOAD_BASE) { return $null }
  $installer = Join-Path $RepoRoot 'scripts\install.ps1'
  if ($Prebuilt) { $installer = Join-Path $RepoRoot 'install.ps1' }
  $result = Invoke-Tool powershell.exe @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-Latest')
  if ($result.ExitCode -ne 0) { return $null }
  $tag = $result.Out.Trim()
  if (-not (ConvertTo-Version $tag)) { return $null }
  return $tag
}

# Asks a yes-or-no question. No is the answer when there is no one at a terminal to ask, unless
# --yes answered for them.
function Confirm-Yes([string]$Question) {
  if ($AssumeYes) { return $true }
  if ([Console]::IsInputRedirected) { return $false }
  $answer = Read-Host "$Question [y/N]"
  return $answer -match '^(y|yes)$'
}

# The layout LoomWatch set the run history up in: the newest table change applied. Empty when
# there is no run history yet, such as before LoomWatch first started.
function Get-DatabaseLayout {
  if (-not (Test-Path -LiteralPath $Binary)) { return '' }
  $result = Invoke-Tool $Binary @('database-layout')
  if ($result.ExitCode -ne 0) { return '' }
  return $result.Out.Trim()
}

# One folder of copies per copy of LoomWatch.
function Get-BackupFolder {
  if (-not $Prebuilt) { $name = (Split-Path -Leaf $RepoRoot).ToLowerInvariant() }
  elseif ($RepoRoot.Equals($UsualApp, [StringComparison]::OrdinalIgnoreCase)) { $name = 'loomwatch-app' }
  else { $name = 'loomwatch-app-' + (Get-Hash $RepoRoot.ToLowerInvariant()).Substring(0, 8) }
  return Join-Path $BackupRoot $name
}

# Saves the run history in one file, a consistent copy made by the program itself even while
# LoomWatch runs, and keeps the newest three copies. Sets $script:BackupFile. $Suffix is added to
# the file's name. False when it could not be saved.
function Save-Database([string]$Suffix) {
  $folder = Get-BackupFolder
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  # Named from the time first, so sorting the names sorts the copies oldest first.
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $script:BackupFile = Join-Path $folder "loomwatch-$stamp-$(Get-InstalledVersion)$Suffix.db"
  $partial = "$($script:BackupFile).partial"
  Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue
  $saved = Invoke-Tool $Binary @('backup', $partial)
  if ($saved.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $partial) -or (Get-Item -LiteralPath $partial).Length -eq 0) {
    Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue
    if ($saved.Err) { Write-Host $saved.Err.Trim() }
    return $false
  }
  Move-Item -LiteralPath $partial -Destination $script:BackupFile
  $copies = @(Get-ChildItem -LiteralPath $folder -Filter 'loomwatch-*.db' | Sort-Object Name)
  if ($copies.Count -gt 3) {
    $copies | Select-Object -First ($copies.Count - 3) | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
  }
  return $true
}

# Before an update can change the run history: notes its layout, so rollback can tell whether the
# earlier version can still read it, and saves a copy.
function Backup-BeforeUpdate {
  $script:LayoutBefore = Get-DatabaseLayout
  $script:BackupFile = ''
  # Never started here: there is no run history yet, so nothing to keep.
  if (-not $script:LayoutBefore) { return }
  if (-not $BackUp) {
    Say 'Not saving a copy of your run history (--no-backup).'
    return
  }
  Step 'Saving a copy of your run history'
  if (-not (Save-Database '')) {
    Fail "the copy of your run history could not be saved, so LoomWatch was not changed. The messages above say why. To update without a copy, run: $Self update --no-backup"
  }
  Say "Saved in $(Pretty $script:BackupFile). The three newest copies are kept."
}

# `update` while LoomWatch runs from this folder: stop it first, if the operator agrees.
function Stop-BeforeUpdate {
  $other = Get-ListenerPid $Port
  if ($other) {
    $program = Get-ProcessProgram $other
    if ($program -and -not $program.Equals($Binary, [StringComparison]::OrdinalIgnoreCase)) {
      Fail "another copy of LoomWatch is running at $Url (process $other, $program). Stop it first, then run $Self update."
    }
  }
  if (-not (Confirm-Yes 'LoomWatch is running. Updating stops it, and any team still working stops too. Stop it and update now?')) {
    Fail "it is still running. Stop it first (press Ctrl+C in its window, or run $Self stop), then run $Self update."
  }
  Stop-LoomWatch
  $script:FailureHeading = 'LoomWatch could not update'
  if (Test-LoomWatchRunning) {
    Fail "it is still running. Stop it first (press Ctrl+C in its window), then run $Self update."
  }
}

# What rollback needs, beside the version the installer kept: which version that is, the layout
# of the run history it ran on, and the copy of the run history saved before the update.
function Save-RollbackNote([string]$Version) {
  $previous = Join-Path $RepoRoot '.previous'
  if (-not (Test-Path -LiteralPath $previous)) { return }
  Write-TextFile (Join-Path $previous 'ROLLBACK') "version=$Version`nlayout=$($script:LayoutBefore)`nbackup=$($script:BackupFile)`n"
}

function Get-RollbackValue([string]$Key) {
  $file = Join-Path $RepoRoot '.previous\ROLLBACK'
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  $value = ''
  foreach ($line in [IO.File]::ReadAllLines($file)) {
    if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1) }
  }
  return $value
}

# This script, started again from the files now in this folder.
function Start-Again {
  $restart = @('start')
  if (-not $OpenBrowser) { $restart += '--no-open' }
  exit (Invoke-Native $Cmd $restart)
}

# Installs a release in this ready-built copy: saves the run history, has the installer replace
# the files, keeping this version in .previous, and notes what rollback needs. Fails, changing
# nothing, when any step does.
function Install-Release([string]$Installed) {
  Backup-BeforeUpdate
  # The installer that put this copy here fetches the release and replaces it in place, keeping
  # the version it replaces in .previous. This script keeps running: Windows PowerShell read all of
  # it when it started.
  $code = Invoke-Native powershell.exe @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RepoRoot 'install.ps1'), '-Update', '-Dir', $RepoRoot)
  if ($code -ne 0) { Fail "the download did not finish, and LoomWatch $Installed was left as it was. The messages above say why." }
  Save-RollbackNote $Installed
}

function Update-LoomWatch {
  $script:FailureHeading = 'LoomWatch could not update'
  if (Test-LoomWatchRunning) { Stop-BeforeUpdate }
  $installed = Get-InstalledVersion
  if ($Prebuilt) {
    # A release asked for by name is installed even when it is older: that is how to go back
    # further than rollback does.
    if (-not $env:LOOMWATCH_VERSION) {
      $latest = Get-LatestRelease
      if ($latest -and -not (Test-Newer $latest $installed)) {
        Say "LoomWatch $installed is the newest version."
        Start-Again
      }
    }
    Install-Release $installed
    if (Test-Path -LiteralPath (Join-Path $RepoRoot '.previous')) { Say "If the new version gives you trouble, $Self rollback goes back to $installed." }
    Start-Again
  }
  if (-not (Test-Command git)) { Fail 'updating needs Git. Install it with: winget install Git.Git' }
  Step 'Downloading the latest LoomWatch'
  $before = (Invoke-Tool git @('rev-parse', 'HEAD')).Out.Trim()
  if ((Invoke-Native git @('pull', '--ff-only')) -ne 0) {
    Fail 'the download did not finish. If Git says your local changes would be overwritten, ask whoever changed files in this folder before discarding them.'
  }
  # The new code changes the run history's layout when it starts, after it is built; the program
  # still here is the one built from the code before the pull.
  if ((Invoke-Tool git @('rev-parse', 'HEAD')).Out.Trim() -ne $before) {
    Backup-BeforeUpdate
    Say "To go back to the code you had: git checkout $($before.Substring(0, 7))"
  }
  $script:FailureHeading = 'LoomWatch could not start'
  Start-LoomWatch
}

# --- Updating from the app (ADR 0052, amended) -----------------------------------------------------
# A ready-built copy's LoomWatch runs beside this script, so Update and restart in the app can hand
# the update to it. LoomWatch names the release in update-request and exits with $UpdateExitCode;
# this script then installs that release as `update` does and starts LoomWatch again in this
# window. When the update does not finish, it starts the version that was running again, and
# tells it why.

function Invoke-Supervised {
  $env:LOOMWATCH_SUPERVISED = '1'
  $env:LOOMWATCH_UPDATE_REQUEST = $UpdateRequest
  $open = $OpenBrowser
  while ($true) {
    Remove-Item -LiteralPath $UpdateRequest -ErrorAction SilentlyContinue
    $code = Invoke-Daemon $open
    $open = $false
    Remove-Item -LiteralPath Env:LOOMWATCH_UPDATE_FAILED -ErrorAction SilentlyContinue
    if ($code -ne $UpdateExitCode) { exit $code }
    Update-FromApp
  }
}

# After LoomWatch stopped for Update and restart. Starts the new version in its place, or returns
# with LOOMWATCH_UPDATE_FAILED set, for the version still here to be started again.
function Update-FromApp {
  $installed = Get-InstalledVersion
  $tag = ''
  if (Test-Path -LiteralPath $UpdateRequest) { $tag = ([IO.File]::ReadAllLines($UpdateRequest) | Select-Object -First 1) }
  Remove-Item -LiteralPath $UpdateRequest, $UpdateFailed -ErrorAction SilentlyContinue
  $heading = $script:FailureHeading
  $script:FailureHeading = 'LoomWatch could not update'
  $script:FailureNote = $UpdateFailed
  try {
    if ([string]$tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*$') { Fail 'LoomWatch did not say which version to install.' }
    if (-not (Test-Newer $tag $installed)) { Fail "$($tag.TrimStart('v')) is not newer than LoomWatch $installed, so nothing was changed." }
    Step "Updating LoomWatch $installed to $($tag.TrimStart('v')), as asked in the app"
    $env:LOOMWATCH_VERSION = $tag
    try { Install-Release $installed } finally { Remove-Item -LiteralPath Env:LOOMWATCH_VERSION -ErrorAction SilentlyContinue }
  } catch {
    # Fail said why, and wrote it down for the app.
  }
  $script:FailureNote = $null
  $script:FailureHeading = $heading
  # Whatever the steps said, the files in place decide which version runs next.
  if ((Get-InstalledVersion) -ne $installed) {
    if (Test-Path -LiteralPath (Join-Path $RepoRoot '.previous')) { Say "If the new version gives you trouble, $Self rollback goes back to $installed." }
    Remove-Item -LiteralPath Env:LOOMWATCH_SUPERVISED, Env:LOOMWATCH_UPDATE_REQUEST -ErrorAction SilentlyContinue
    # The app's tab is still open, and it waits for the new version: no second tab.
    exit (Invoke-Native $Cmd @('start', '--no-open'))
  }
  $why = ''
  if (Test-Path -LiteralPath $UpdateFailed) { $why = [IO.File]::ReadAllText($UpdateFailed) }
  Remove-Item -LiteralPath $UpdateFailed -ErrorAction SilentlyContinue
  if (-not $why) { $why = 'the update stopped before it finished. The window running LoomWatch says why.' }
  $env:LOOMWATCH_UPDATE_FAILED = $why
  Step "Starting LoomWatch $installed again"
}

# Puts a saved copy in place of the run history file: copied beside it first, then moved over it,
# so the file in use is replaced only once the copy is whole.
function Restore-Database([string]$Backup) {
  $database = Get-DatabaseFile
  $restoring = "$database.restoring"
  Remove-Item -LiteralPath $restoring -ErrorAction SilentlyContinue
  try {
    Copy-Item -LiteralPath $Backup -Destination $restoring
  } catch {
    Remove-Item -LiteralPath $restoring -ErrorAction SilentlyContinue
    Fail "the copy in $(Pretty $Backup) could not be restored, so nothing was changed. $($_.Exception.Message)"
  }
  # The write-ahead log belongs to the file being replaced, and would be read into the copy. What
  # it held is in the copy saved just before this.
  Remove-Item -LiteralPath "$database-wal", "$database-shm" -ErrorAction SilentlyContinue
  try {
    Move-Item -LiteralPath $restoring -Destination $database -Force
  } catch {
    Fail "the copy could not be put in place. It is in $(Pretty $restoring); the copy saved before going back is in $(Pretty $script:BackupFile)."
  }
}

# An update may have changed how the run history is stored, which the earlier version cannot read.
# Then the run history goes back to the copy saved before the update, after what was recorded
# since is saved to a copy of its own.
function Restore-DatabaseIfNeeded([string]$Current, [string]$Previous) {
  $layoutThen = Get-RollbackValue 'layout'
  $backup = Get-RollbackValue 'backup'
  if (-not $layoutThen) { return }
  $layoutNow = Get-DatabaseLayout
  if (-not $layoutNow -or $layoutNow -eq $layoutThen) { return }
  if (-not $backup -or -not (Test-Path -LiteralPath $backup)) {
    Fail "LoomWatch $Current changed how your run history is stored, and $Previous cannot read it. The copy saved before the update is gone, so nothing was changed. Keep using $Current by running: $Self"
  }
  Say "LoomWatch $Current changed how your run history is stored, and $Previous cannot read it. Going back also puts the run history back to the copy saved before the update, $(Pretty $backup). What was recorded since is saved to another copy first; $Previous will not show it."
  if (-not (Confirm-Yes "Go back to $Previous, with the run history from before the update?")) { Fail 'nothing was changed.' }
  Step 'Putting the run history back'
  if (-not (Save-Database '-before-rollback')) {
    Fail 'the run history recorded since the update could not be saved, so nothing was changed. The messages above say why.'
  }
  Say "Saved the run history recorded since the update in $(Pretty $script:BackupFile)."
  Restore-Database $backup
}

# Moves the kept version's files over the current ones. Each is a move in this folder; the current
# version's files wait in a scratch folder until every one is in place.
function Restore-Previous {
  $previous = Join-Path $RepoRoot '.previous'
  $scratch = Join-Path $RepoRoot (".loomwatch-rollback." + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $scratch | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $previous -Force) {
    if ($item.Name -eq 'ROLLBACK') { continue }
    $target = Join-Path $RepoRoot $item.Name
    try {
      if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination (Join-Path $scratch $item.Name) }
      Move-Item -LiteralPath $item.FullName -Destination $target
    } catch {
      Fail "could not put $($item.Name) back. The files of both versions are in $(Pretty $RepoRoot) and $(Pretty $scratch)."
    }
  }
  Remove-Item -LiteralPath $previous, $scratch -Recurse -Force
}

function Undo-Update {
  $script:FailureHeading = 'LoomWatch could not go back'
  if (-not $Prebuilt) {
    Fail "rollback is for a ready-built copy. In a copy of the source code, Git keeps every version: find the one you want with git log, git checkout it, then run $Self"
  }
  $previous = Join-Path $RepoRoot '.previous'
  if (-not (Test-Path -LiteralPath (Join-Path $previous 'bin\loomwatchd.exe')) -or -not (Test-Path -LiteralPath (Join-Path $previous 'loomwatch.cmd'))) {
    Fail "no earlier version is kept in $(Pretty $RepoRoot). Each update keeps the version it replaced, until the next update. To install a particular release instead, run: `$env:LOOMWATCH_VERSION='v0.5.0'; $Self update (the versions are listed at https://github.com/tnghia903/loomwatch/releases)"
  }
  if (Test-LoomWatchRunning) {
    Fail "it is still running. Stop it first (press Ctrl+C in its window, or run $Self stop), then run $Self rollback."
  }
  $current = Get-InstalledVersion
  $previousVersion = ''
  $previousFile = Join-Path $previous 'VERSION'
  if (Test-Path -LiteralPath $previousFile) { $previousVersion = ([IO.File]::ReadAllText($previousFile).Trim() -split ' ')[0] }
  if (-not $previousVersion) { $previousVersion = 'the earlier version' }
  Step "Going back from LoomWatch $current to $previousVersion"
  Restore-DatabaseIfNeeded $current $previousVersion
  Restore-Previous
  Say "LoomWatch is back to $previousVersion. Run $Self update when you want the newest version again."
  Start-Again
}

function Show-Version {
  $installed = Get-InstalledVersion
  $commit = Get-Commit
  $label = $installed
  if (-not $label) { $label = '(version unknown)' }
  if ($commit) { $label = "$label ($commit)" }
  Say "LoomWatch $label"
  if (Test-UpdateCheckOff) {
    Say 'Checking for new versions is off (LOOMWATCH_UPDATE_CHECK).'
  } else {
    $latest = Get-LatestRelease
    if (-not $latest) { Say 'Could not ask GitHub for the newest release.' }
    elseif (Test-Newer $latest $installed) { Say "LoomWatch $($latest.TrimStart('v')) is out. Update with: $Self update" }
    elseif (Test-Newer $installed $latest) { Say "This is newer than the newest release, $($latest.TrimStart('v'))." }
    else { Say 'This is the newest release.' }
  }
  $previousFile = Join-Path $RepoRoot '.previous\VERSION'
  if ($Prebuilt -and (Test-Path -LiteralPath $previousFile)) {
    Say "The version it replaced, $(([IO.File]::ReadAllText($previousFile).Trim() -split ' ')[0]), is kept: $Self rollback goes back to it."
  }
}

function Show-Usage {
  $startDoes = 'Set up anything missing, build if needed, start LoomWatch and open it (the default)'
  $updateDoes = 'Save a copy of the run history, download the latest LoomWatch, rebuild it and start it'
  $rollbackLine = ''
  $rebuildOption = "`n  --rebuild     Build again even if nothing changed"
  if ($Prebuilt) {
    $startDoes = 'Set up anything missing, start LoomWatch and open it (the default)'
    $updateDoes = 'Save a copy of the run history, install the newest release, then start it'
    $rollbackLine = "`n  rollback  Go back to the version the last update replaced"
    $rebuildOption = ''
  }
  Write-Host @"
Usage: $Self [command] [options]

Commands:
  start     $startDoes
  update    $updateDoes$rollbackLine
  version   Say which version this is, and whether a newer one is out
  stop      Stop LoomWatch. Your teams and history are kept.
  help      Show this help

Options:
  --no-open     Do not open the browser
  --no-backup   Update without saving a copy of the run history first
  --yes         Answer yes to questions, such as stopping LoomWatch to update it$rebuildOption

Settings (environment variables):
  LOOMWATCH_TEAMS_ROOT     Where your teams live (now: $(Pretty $TeamsRoot))
  LOOMWATCH_PORT           Browser port (now: $Port)
  LOOMWATCH_DATABASE       The file that holds the run history
  LOOMWATCH_BACKUP_DIR     Where updates save copies of the run history (now: $(Pretty $BackupRoot))
  LOOMWATCH_UPDATE_CHECK   off: never ask GitHub whether a newer version is out
"@
}

switch ($Command) {
  'start' { Start-LoomWatch }
  'update' { Update-LoomWatch }
  'rollback' { Undo-Update }
  'version' { Show-Version }
  'stop' { Stop-LoomWatch }
  'help' { Show-Usage }
}
