# One command to set up, build, start, update and stop LoomWatch on Windows: the Windows twin of
# the ./loomwatch script, run through loomwatch.cmd.
#
#   loomwatch            set up anything missing, build if the code changed, start, open the browser
#   loomwatch update     download the latest version, rebuild, and start
#   loomwatch stop       stop LoomWatch and its database (your teams and history are kept)
#
# The same script runs a copy of the source code, which it builds, and a ready-built copy put in
# %USERPROFILE%\LoomWatch\app by install.ps1, which carries its program in bin\ and updates from the
# newest release instead of from Git.
#
# Optional settings, read from the environment:
#   LOOMWATCH_TEAMS_ROOT    where your teams live (default: ~\LoomWatch\teams)
#   LOOMWATCH_PORT          browser port (default: LOOMWATCH_PORT in .env, else 3000)
#   LOOMWATCH_DATABASE_URL  use your own PostgreSQL instead of the one this script runs in Docker
#
# Written for the Windows PowerShell 5.1 every Windows 10 and 11 computer has, and kept to ASCII:
# Windows PowerShell reads a script without a byte-order mark in the local code page.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

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
function Say([string]$Text) { Write-Host $Text }
function Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) {
  Write-Host ''
  Write-Host "$($script:FailureHeading): $Text" -ForegroundColor Red
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
foreach ($dir in @((Join-Path $HomeFolder '.cargo\bin'), (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'))) {
  if ((Test-Path -LiteralPath $dir) -and -not (($env:Path -split ';') -contains $dir)) {
    $env:Path = "$env:Path;$dir"
  }
}

$Command = 'start'
$OpenBrowser = $true
$ForceRebuild = $false
foreach ($arg in $args) {
  switch -Exact ($arg) {
    'start' { $Command = 'start' }
    'update' { $Command = 'update' }
    'stop' { $Command = 'stop' }
    'help' { $Command = 'help' }
    '-h' { $Command = 'help' }
    '--help' { $Command = 'help' }
    '/?' { $Command = 'help' }
    '--no-open' { $OpenBrowser = $false }
    '--rebuild' { $ForceRebuild = $true }
    default {
      $script:FailureHeading = 'LoomWatch'
      Fail "unknown option '$arg'. Run $Self help to see the options."
    }
  }
}

$TeamsRoot = $env:LOOMWATCH_TEAMS_ROOT
if (-not $TeamsRoot) { $TeamsRoot = Join-Path $HomeFolder 'LoomWatch\teams' }
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

function Use-DockerDatabase { return -not $env:LOOMWATCH_DATABASE_URL }

function Test-DockerRunning {
  if (-not (Test-Command docker)) { return $false }
  return (Invoke-Tool docker @('info')).ExitCode -eq 0
}

function Get-RunningDatabase {
  return (Invoke-Tool docker @('compose', 'ps', '--status', 'running', '--quiet', 'postgres')).Out.Trim()
}

function Test-DatabaseRunning {
  return (Test-DockerRunning) -and [bool](Get-RunningDatabase)
}

function Get-DockerDesktop {
  $app = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path -LiteralPath $app) { return $app }
  return $null
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

# A Docker Compose project name no other folder uses, for a copy whose database must be its own.
function Get-OwnProjectName {
  $prefix = 'loomwatch'
  if ($Prebuilt) { $prefix = 'loomwatch-app' }
  return "$prefix-$((Get-Hash $RepoRoot.ToLowerInvariant()).Substring(0, 8))"
}

# Compose finds a database by its project name alone, so two folders with the same name share one:
# starting either takes the database over. Returns the other copy's folder when the database was
# created from one that is still there; one whose folder is gone is this copy's to adopt.
function Get-OtherDatabaseOwner {
  $id = ((Invoke-Tool docker @('compose', 'ps', '--all', '--quiet', 'postgres')).Out -split "`n" | Select-Object -First 1).Trim()
  if (-not $id) { return $null }
  $owner = (Invoke-Tool docker @('inspect', '--format', '{{index .Config.Labels "com.docker.compose.project.working_dir"}}', $id)).Out.Trim()
  if (-not $owner -or -not (Test-Path -LiteralPath $owner)) { return $null }
  $owner = (Resolve-Path -LiteralPath $owner).ProviderPath.TrimEnd('\')
  if ($owner -eq $RepoRoot.TrimEnd('\')) { return $null }
  if (-not (Test-Path -LiteralPath (Join-Path $owner 'docker-compose.yml'))) { return $null }
  return $owner
}

function Assert-NotOtherCopysDatabase {
  $owner = Get-OtherDatabaseOwner
  if ($owner) {
    Fail "the LoomWatch copy in $(Pretty $owner) uses the same database as this one, and starting it here would take that database over. If you no longer use that copy, delete its folder and run $Self again: this copy then keeps the database and its run history. To keep both copies, set COMPOSE_PROJECT_NAME=$(Get-OwnProjectName) in $(WhereIs '.env') so this one gets a database of its own (it starts with an empty run history), then run $Self again."
  }
}

# Whether the database still holds what LoomWatch set up when it started, not a new, empty one.
function Test-DatabaseHasLoomWatchTables {
  $found = Invoke-Tool docker @('compose', 'exec', '-T', 'postgres', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA') "select to_regclass('public._sqlx_migrations') is not null;`n"
  return $found.Out.Trim() -eq 't'
}

# A LoomWatch answering on the port is only this one when it was started from this folder, and it
# only works while its database runs.
function Confirm-AlreadyRunning {
  $listener = Get-ListenerPid $Port
  if ($listener) {
    $program = Get-ProcessProgram $listener
    if ($program -and $program -ne $Binary) {
      Fail "another copy of LoomWatch is already running at $Url (process $listener, started from $program). Stop it with: Stop-Process -Id $listener
Then run $Self again. To keep it running, start this copy on another port instead: `$env:LOOMWATCH_PORT=$([int]$Port + 1); $Self"
    }
  }
  if ((Use-DockerDatabase) -and -not (Test-DatabaseRunning)) {
    # This copy outlived its database: the container was stopped or removed, or Docker Desktop was
    # quit. It is started again here, and LoomWatch reconnects on its next query, as long as the
    # database still holds its tables.
    Say "LoomWatch is running at $Url, but its database had stopped. Starting the database again."
    Start-DockerDesktop
    Start-Database
    if (-not (Test-DatabaseHasLoomWatchTables)) {
      Fail "the database LoomWatch was using is gone, and LoomWatch only sets up a new one when it starts. Stop it with: $Self stop
Then run $Self again."
    }
  }
  Say "LoomWatch is already running at $Url"
  Open-Url $Url
  exit 0
}

# Whether this computer has a Python 3 the offline demo team can run: the Microsoft Store's
# python3.exe stand-in, which only says Python is not installed, does not count.
function Test-Python {
  foreach ($name in @('python3', 'python', 'py')) {
    $found = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue |
      Where-Object { $_.Source -notmatch '\\Microsoft\\WindowsApps\\' } | Select-Object -First 1
    if ($found) { return $true }
  }
  $store = Invoke-Tool python3 @('--version')
  return $store.ExitCode -eq 0 -and $store.Out -match 'Python 3'
}

# Every missing tool in one list, so nobody fixes one, reruns, and only then meets the next.
function Assert-Prerequisites {
  $missing = New-Object System.Collections.Generic.List[string]
  $winget = Test-Command winget

  if (Use-DockerDatabase) {
    $desktop = Get-DockerDesktop
    if (-not (Test-Command docker) -and $desktop) {
      # Docker Desktop puts its docker command on PATH for terminals opened after it is set up.
      Start-Process $desktop
      $missing.Add("  - Docker Desktop is installed but has not been set up yet. It is opening now: finish its
    first-start steps, wait until it says it is running, then open a new terminal and run $Self again.")
    } elseif (-not (Test-Command docker) -or (Invoke-Tool docker @('compose', 'version')).ExitCode -ne 0) {
      if ($winget) {
        $missing.Add('  - Docker Desktop, which runs the database: winget install Docker.DockerDesktop
    (or download it from https://docs.docker.com/desktop/), then open it once.')
      } else {
        $missing.Add('  - Docker Desktop, which runs the database: https://docs.docker.com/desktop/
    Open it once after installing.')
      }
    }
  }

  # Only a copy of the source code is built here; a ready-built copy needs neither Node.js nor Rust.
  if (-not $Prebuilt) {
    if (-not (Test-Command node)) {
      if ($winget) { $missing.Add('  - Node.js 22 or newer, which builds the browser app: winget install OpenJS.NodeJS.LTS') }
      else { $missing.Add('  - Node.js 22 or newer, which builds the browser app: https://nodejs.org/') }
    } else {
      $version = (Invoke-Tool node @('--version')).Out.Trim().TrimStart('v')
      $parts = $version.Split('.')
      $major = 0; $minor = 0
      [void][int]::TryParse($parts[0], [ref]$major)
      if ($parts.Count -gt 1) { [void][int]::TryParse($parts[1], [ref]$minor) }
      if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 12)) {
        $missing.Add("  - A newer Node.js: LoomWatch needs 22.12 or newer and this computer has v$version.
    Install the current version from https://nodejs.org/")
      }
    }
    if (-not (Test-Command cargo)) {
      $missing.Add('  - Rust, which builds the LoomWatch program: https://rustup.rs (run rustup-init.exe and let it
    install the Visual Studio C++ build tools it asks for)')
    }
  }

  if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host 'LoomWatch needs a few things installed first:' -ForegroundColor Yellow
    foreach ($item in $missing) { Write-Host $item }
    Write-Host ''
    Say "When they are installed, open a new terminal window and run $Self again."
    exit 1
  }

  if (-not (Test-Python)) {
    if ($winget) { Say 'Note: the offline demo team needs Python 3. Install it with: winget install Python.Python.3.13' }
    else { Say 'Note: the offline demo team needs Python 3, from https://www.python.org/downloads/' }
  }
}

function New-Secret {
  $bytes = New-Object byte[] 24
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) } finally { $random.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

# UTF-8 without a byte-order mark, and Unix line ends: Docker Compose reads .env, and a mark in
# front of its first name would hide that setting.
function Write-TextFile([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
}

function Initialize-EnvFile {
  $file = Join-Path $RepoRoot '.env'
  if (Test-Path -LiteralPath $file) { return }
  $example = Join-Path $RepoRoot '.env.example'
  if (-not (Test-Path -LiteralPath $example)) { Fail ".env.example is missing from $RepoRoot. Download LoomWatch again." }
  # Another PostgreSQL on the usual port is common enough to step around instead of failing on.
  $dbPort = 5433
  while ((Test-PortInUse $dbPort) -and $dbPort -lt 5460) { $dbPort++ }
  $lines = foreach ($line in [IO.File]::ReadAllLines($example)) {
    if ($line.StartsWith('POSTGRES_PASSWORD=')) { "POSTGRES_PASSWORD=$(New-Secret)" }
    elseif ($line.StartsWith('POSTGRES_PORT=')) { "POSTGRES_PORT=$dbPort" }
    elseif ($line.StartsWith('LOOMWATCH_HOST_RUNNER_TOKEN=')) { "LOOMWATCH_HOST_RUNNER_TOKEN=$(New-Secret)" }
    else { $line }
  }
  $text = ($lines -join "`n") + "`n"
  if ($Prebuilt) {
    # Compose names a project after its folder, and this one is called just `app`, like many other
    # projects whose database this would otherwise take over. Only the usual folder is
    # loomwatch-app: a copy installed anywhere else, such as a release being tried, gets its own.
    $project = 'loomwatch-app'
    $usual = Join-Path $HomeFolder 'LoomWatch\app'
    if ($RepoRoot.TrimEnd('\') -ne $usual) { $project = Get-OwnProjectName }
    $text += "`n# The Docker Compose project that holds the database.`nCOMPOSE_PROJECT_NAME=$project`n"
  }
  Write-TextFile $file $text
  Say 'Created your settings file (.env) with a random database password.'
}

# Fails before the long build, not after it, when the database's port belongs to something else.
function Assert-DatabasePort {
  if (-not (Use-DockerDatabase)) { return }
  if (Test-DockerRunning) { Assert-NotOtherCopysDatabase }
  $dbPort = EnvValue 'POSTGRES_PORT'
  if (-not $dbPort) { $dbPort = '5433' }
  if (-not (Test-PortInUse $dbPort)) { return }
  if ((Test-DockerRunning) -and (Get-RunningDatabase)) { return }
  Fail "another program is using port $dbPort, which the LoomWatch database needs. Change POSTGRES_PORT in $(WhereIs '.env') to a free port such as $([int]$dbPort + 1), then run $Self again."
}

function Initialize-TeamsRoot {
  if (Test-Path -LiteralPath $TeamsRoot) { return }
  New-Item -ItemType Directory -Force -Path $TeamsRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'examples\operator-stop.yaml'), (Join-Path $RepoRoot 'examples\operator-stop-harness.py') -Destination $TeamsRoot
  Say "Created your teams folder at $(Pretty $TeamsRoot), with an offline demo team in it."
}

# Asks Docker Desktop to start without waiting, so it boots while LoomWatch builds.
function Start-DockerDesktop {
  if (-not (Use-DockerDatabase)) { return }
  if (Test-DockerRunning) { return }
  $desktop = Get-DockerDesktop
  if ($desktop) {
    Say 'Starting Docker Desktop. If it asks you to accept its terms, do that and LoomWatch will carry on.'
    Start-Process $desktop
  }
}

function Start-Database {
  if (-not (Use-DockerDatabase)) {
    $script:DatabaseUrl = $env:LOOMWATCH_DATABASE_URL
    return
  }
  if (-not (Test-DockerRunning)) {
    if (Get-DockerDesktop) {
      Say 'Waiting for Docker to finish starting...'
      $waited = 0
      while (-not (Test-DockerRunning)) {
        if ($waited -ge 180) { Fail "Docker did not start within three minutes. Open Docker Desktop, wait until it says it is running, then run $Self again." }
        Start-Sleep -Seconds 2
        $waited += 2
      }
    } else {
      Fail "Docker is not running. Start Docker, then run $Self again."
    }
  }

  $user = EnvValue 'POSTGRES_USER'
  $password = EnvValue 'POSTGRES_PASSWORD'
  $db = EnvValue 'POSTGRES_DB'
  $dbPort = EnvValue 'POSTGRES_PORT'
  if (-not $dbPort) { $dbPort = '5433' }
  Step 'Starting the database'
  Assert-NotOtherCopysDatabase
  if ((Invoke-Native docker @('compose', 'up', '--detach', '--wait', 'postgres')) -ne 0) {
    Fail "the database did not start. If the message above says port $dbPort is already in use, change POSTGRES_PORT in $(WhereIs '.env') to a free port such as $([int]$dbPort + 1), then run $Self again."
  }
  Sync-DatabasePassword
  $script:DatabaseUrl = "postgres://${user}:${password}@127.0.0.1:$dbPort/$db"
}

# PostgreSQL keeps the password it was created with, and Compose names the database after this
# folder. So LoomWatch downloaded again into a folder named like an earlier copy finds that copy's
# database, which refuses the new random password in .env. The database is LoomWatch's own and its
# history goes with the teams every copy shares, so it takes this folder's password instead.
function Sync-DatabasePassword {
  # Inside the container a connection through its network address is password-checked exactly like
  # LoomWatch's own; one through the local socket is trusted, which is what lets this fix it.
  $check = Invoke-Tool docker @('compose', 'exec', '-T', 'postgres', 'sh', '-c', 'PGPASSWORD=$POSTGRES_PASSWORD psql -h "$(hostname)" -U "$POSTGRES_USER" -d postgres -tAc "select 1"')
  if ($check.ExitCode -eq 0) { return }
  if ($check.Err -notmatch 'password authentication failed') { return } # Left for LoomWatch itself to report.
  $alter = Invoke-Tool docker @('compose', 'exec', '-T', 'postgres', 'sh', '-c', 'psql -v ON_ERROR_STOP=1 -v user="$POSTGRES_USER" -v password="$POSTGRES_PASSWORD" -U "$POSTGRES_USER" -d postgres -q') "ALTER ROLE :`"user`" WITH PASSWORD :'password';`n"
  if ($alter.ExitCode -eq 0) {
    Say "Found the database of an earlier LoomWatch copy on this computer. It now uses the password in this folder's .env, so its run history is kept."
    return
  }
  Fail "the database Docker kept from an earlier LoomWatch copy refuses the password in $(WhereIs '.env'), and LoomWatch could not change it. To start over with an empty run history, run: docker compose down --volumes in $(Pretty $RepoRoot) (this deletes the earlier history; your teams are kept), then $Self again."
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

function Start-LoomWatch {
  if (Test-LoomWatchRunning) { Confirm-AlreadyRunning }
  if (Test-PortInUse $Port) {
    Fail "another program is using port $Port. Start LoomWatch on a different port with: `$env:LOOMWATCH_PORT=$([int]$Port + 1); $Self"
  }

  Assert-Prerequisites
  Initialize-EnvFile
  Initialize-TeamsRoot
  Start-DockerDesktop
  Assert-DatabasePort
  Invoke-BuildIfNeeded
  Start-Database

  $env:DATABASE_URL = $script:DatabaseUrl
  # Compose-mode settings in the operator's own shell would point this native daemon at a container
  # runner or a container-only capability folder.
  foreach ($name in @('LOOMWATCH_CAPABILITY_HOME', 'LOOMWATCH_HOST_RUNNER_ADDR', 'LOOMWATCH_HOST_RUNNER_TOKEN')) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  }
  # Which checkout is running, for the "Send feedback" report. `-dirty` marks local edits. A
  # ready-built copy names the commit its release was built from, in VERSION.
  $commit = ''
  if ($Prebuilt) {
    $versionFile = Join-Path $RepoRoot 'VERSION'
    if (Test-Path -LiteralPath $versionFile) {
      $fields = ([IO.File]::ReadAllText($versionFile)).Trim().Split(' ')
      if ($fields.Count -gt 1) { $commit = $fields[1] }
    }
  } elseif (Test-Command git) {
    $commit = (Invoke-Tool git @('describe', '--always', '--dirty', '--abbrev=7')).Out.Trim()
  }
  $env:LOOMWATCH_COMMIT = $commit

  Step "LoomWatch is starting at $Url"
  Say "Your teams are in $(Pretty $TeamsRoot)"
  Say 'Keep this window open while you use LoomWatch. Press Ctrl+C to stop it.'
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

  # The program shares this window, so Ctrl+C reaches it exactly as if it had been started by hand,
  # and the browser opens once it answers.
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Binary
  $info.Arguments = (@('serve', '--teams-root', $TeamsRoot, '--listen', "127.0.0.1:$Port") | ForEach-Object { ConvertTo-Argument $_ }) -join ' '
  $info.UseShellExecute = $false
  $info.WorkingDirectory = $RepoRoot
  $daemon = [System.Diagnostics.Process]::Start($info)
  Write-TextFile $PidFile "$($daemon.Id)`n"
  try {
    $opened = $false
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
  exit $daemon.ExitCode
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
      # each of which LoomWatch keeps in a job that closes with it.
      Stop-Process -Id $id -Force
      if (-not $process.WaitForExit(10000)) { Fail "LoomWatch (process $id) is still running. Stop it in Task Manager." }
      $stopped = $true
      Say 'Stopped LoomWatch.'
    }
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
  }
  if (-not $stopped -and (Test-LoomWatchRunning)) {
    $other = Get-ListenerPid $Port
    if ($other) {
      Say "LoomWatch at $Url was not started by $Self in this folder. It is process $other, from $(Get-ProcessProgram $other). Press Ctrl+C in the window running it, or run: Stop-Process -Id $other"
    } else {
      Say "LoomWatch at $Url was not started by $Self. Press Ctrl+C in the window running it."
    }
  }

  if ((Use-DockerDatabase) -and (Test-DockerRunning)) {
    $owner = Get-OtherDatabaseOwner
    if ($owner) {
      Say "Left the database alone: it belongs to the LoomWatch copy in $(Pretty $owner)."
    } else {
      [void](Invoke-Native docker @('compose', 'stop', 'postgres'))
      Say 'Stopped the database. Your teams and history are kept.'
    }
  }
}

function Update-LoomWatch {
  $script:FailureHeading = 'LoomWatch could not update'
  if (Test-LoomWatchRunning) {
    Fail "it is still running. Stop it first (press Ctrl+C in its window, or run $Self stop), then run $Self update."
  }
  if ($Prebuilt) {
    # The installer that put this copy here fetches the newest release and replaces it in place,
    # then this copy starts again from the new files.
    $installed = Invoke-Native powershell.exe @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RepoRoot 'install.ps1'), '-Update', '-Dir', $RepoRoot)
    if ($installed -ne 0) { Fail 'the download did not finish. The messages above say why.' }
    $restart = @('start')
    if (-not $OpenBrowser) { $restart += '--no-open' }
    exit (Invoke-Native $Cmd $restart)
  }
  if (-not (Test-Command git)) { Fail 'updating needs Git. Install it with: winget install Git.Git' }
  Step 'Downloading the latest LoomWatch'
  if ((Invoke-Native git @('pull', '--ff-only')) -ne 0) {
    Fail 'the download did not finish. If Git says your local changes would be overwritten, ask whoever changed files in this folder before discarding them.'
  }
  $script:FailureHeading = 'LoomWatch could not start'
  Start-LoomWatch
}

function Show-Usage {
  $startDoes = 'Set up anything missing, build if needed, start LoomWatch and open it (the default)'
  $updateDoes = 'Download the latest LoomWatch, rebuild it and start it'
  $rebuildOption = "`n  --rebuild   Build again even if nothing changed"
  if ($Prebuilt) {
    $startDoes = 'Set up anything missing, start LoomWatch and open it (the default)'
    $updateDoes = 'Download and install the newest release, then start it'
    $rebuildOption = ''
  }
  Write-Host @"
Usage: $Self [command] [options]

Commands:
  start     $startDoes
  update    $updateDoes
  stop      Stop LoomWatch and its database. Your teams and history are kept.
  help      Show this help

Options:
  --no-open   Do not open the browser$rebuildOption

Settings (environment variables):
  LOOMWATCH_TEAMS_ROOT     Where your teams live (now: $(Pretty $TeamsRoot))
  LOOMWATCH_PORT           Browser port (now: $Port)
  LOOMWATCH_DATABASE_URL   Use your own PostgreSQL instead of the one in Docker
"@
}

switch ($Command) {
  'start' { Start-LoomWatch }
  'update' { Update-LoomWatch }
  'stop' { Stop-LoomWatch }
  'help' { Show-Usage }
}
