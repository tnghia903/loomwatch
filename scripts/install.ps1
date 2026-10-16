# Installs LoomWatch on Windows from its newest release, or updates a copy installed this way.
#
#   powershell -ExecutionPolicy Bypass -c "irm https://loomwatch.github.io/install.ps1 | iex"
#
# Downloads the ready-built LoomWatch for Windows from GitHub, checks it against the release's
# checksum, puts it in %USERPROFILE%\LoomWatch\app and starts it. Nothing is compiled, nothing needs
# an administrator, and nothing outside %USERPROFILE%\LoomWatch changes, apart from adding that
# folder to your own PATH so a new terminal knows the `loomwatch` command. Running it again updates
# LoomWatch and keeps your settings, teams and history.
#
# (Most people install LoomWatch-windows-setup.exe instead, the app that lives beside the clock.
# This is the terminal way, as install.sh is on a Mac.)
#
# Optional settings, read from the environment:
#   LOOMWATCH_APP_DIR    where to install (default: ~\LoomWatch\app)
#   LOOMWATCH_VERSION    a release such as v0.2.0 (default: the newest)
#   LOOMWATCH_NO_START   1 to install without starting LoomWatch
#
# Options when run as a file: -NoStart (install only), -Update and -Dir DIR (used by
# `loomwatch update`), and -Latest, which only prints the newest release's tag, such as v0.5.0.
#
# An update keeps the version it replaces in .previous inside the install folder, for
# `loomwatch rollback`, and replaces nothing at all when any part of it fails.
#
# Everything runs from the call on the last line, so a download cut off halfway never runs half a
# script. Kept to ASCII for Windows PowerShell 5.1, which reads a script without a byte-order mark
# in the local code page.
param(
  [switch]$NoStart,
  [switch]$Update,
  [switch]$Latest,
  [string]$Dir
)

function Install-LoomWatch {
  param([switch]$NoStart, [switch]$Update, [switch]$Latest, [string]$Dir)
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
  # Invoke-WebRequest draws its progress bar so slowly in Windows PowerShell that it slows the
  # download itself.
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 offers only old TLS versions unless asked; GitHub needs 1.2.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'tnghia903/loomwatch'
  $homeFolder = [Environment]::GetFolderPath('UserProfile')
  function Say([string]$Text) { Write-Host $Text }
  function Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
  function Fail([string]$Text) {
    Write-Host ''
    Write-Host "LoomWatch could not be installed: $Text" -ForegroundColor Red
    throw 'LoomWatch could not be installed.'
  }
  # The SHA-256 of a file, as .NET computes it: Get-FileHash is missing from a Windows PowerShell
  # whose modules a PowerShell 7 hid.
  function Get-Sha256([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
    finally { $stream.Dispose(); $sha.Dispose() }
  }
  function Pretty([string]$Path) {
    if ($Path.StartsWith($homeFolder + '\', [StringComparison]::OrdinalIgnoreCase)) {
      return '~' + $Path.Substring($homeFolder.Length)
    }
    return $Path
  }

  # The newest published release's tag, from where GitHub's releases/latest page leads: a page,
  # not the API, so it never meets the API's hourly limit.
  function Get-LatestTag {
    $request = [System.Net.HttpWebRequest]::Create("https://github.com/$repo/releases/latest")
    $request.Method = 'HEAD'
    $request.AllowAutoRedirect = $false
    $request.Timeout = 30000
    $response = $request.GetResponse()
    try { $location = [string]$response.Headers['Location'] } finally { $response.Close() }
    $marker = '/releases/tag/'
    $at = $location.IndexOf($marker)
    if ($at -lt 0) { return $null }
    $tag = $location.Substring($at + $marker.Length)
    if ($tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*$') { return $null }
    return $tag
  }

  if ($Latest) {
    $tag = $null
    try { $tag = Get-LatestTag } catch { $tag = $null }
    if (-not $tag) { Fail 'could not ask GitHub for the newest release.' }
    Write-Output $tag
    return
  }

  # One file runs on every Windows computer: Windows on Arm runs it through its x64 emulation.
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Fail "this installer is for Windows. On macOS and Linux run: curl -fsSL https://loomwatch.github.io/install.sh | bash"
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    Fail "LoomWatch needs 64-bit Windows. See https://github.com/$repo#build-from-source"
  }
  $asset = 'loomwatch-windows-x86_64.zip'

  $appDir = $Dir
  if (-not $appDir) { $appDir = $env:LOOMWATCH_APP_DIR }
  if (-not $appDir) { $appDir = Join-Path $homeFolder 'LoomWatch\app' }
  $appDir = [IO.Path]::GetFullPath($appDir)
  $start = -not ($NoStart -or $Update -or $env:LOOMWATCH_NO_START -eq '1')

  if ($env:LOOMWATCH_VERSION) {
    $base = "https://github.com/$repo/releases/download/$($env:LOOMWATCH_VERSION)"
  } else {
    $base = "https://github.com/$repo/releases/latest/download"
  }
  # Testing a release before it is published: point this at a folder served over http.
  if ($env:LOOMWATCH_DOWNLOAD_BASE) { $base = $env:LOOMWATCH_DOWNLOAD_BASE.TrimEnd('/') }

  if ((Test-Path -LiteralPath $appDir) -and -not (Test-Path -LiteralPath (Join-Path $appDir 'bin\loomwatchd.exe'))) {
    if (Test-Path -LiteralPath (Join-Path $appDir 'Cargo.toml')) {
      Fail "$(Pretty $appDir) is a copy of LoomWatch's source code. Update it with .\loomwatch.cmd update there, or set LOOMWATCH_APP_DIR to another folder."
    } elseif (Get-ChildItem -LiteralPath $appDir -Force | Select-Object -First 1) {
      Fail "$(Pretty $appDir) already exists and is not a LoomWatch installed by this script. Move it away, or set LOOMWATCH_APP_DIR to another folder."
    }
  }
  # Windows will not replace a program that is running, and LoomWatch may be mid-run.
  $pidFile = Join-Path $appDir 'run\loomwatchd.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $id = 0
    [void][int]::TryParse(([IO.File]::ReadAllText($pidFile)).Trim(), [ref]$id)
    $running = $null
    if ($id -gt 0) { $running = Get-Process -Id $id -ErrorAction SilentlyContinue }
    if ($running -and $running.ProcessName -eq 'loomwatchd') {
      Fail "LoomWatch is running from $(Pretty $appDir). Stop it first (press Ctrl+C in its window, or run loomwatch stop), then run this again."
    }
  }

  $parent = Split-Path -Parent $appDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  # Unpacked next to the install folder, so putting it in place is a rename on the same disk.
  $tmp = Join-Path $parent (".loomwatch-download." + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Step 'Downloading LoomWatch for Windows'
    $archive = Join-Path $tmp $asset
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $archive
    } catch {
      if ($env:LOOMWATCH_VERSION) {
        Fail "could not download $asset from release $($env:LOOMWATCH_VERSION). Check the version at https://github.com/$repo/releases"
      }
      Fail "could not download $asset. Check your internet connection, or see https://github.com/$repo/releases"
    }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset.sha256" -OutFile "$archive.sha256"
    } catch {
      Fail "could not download the checksum for $asset, so the download cannot be checked."
    }

    $expected = ([IO.File]::ReadAllText("$archive.sha256").Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = Get-Sha256 $archive
    if (-not $expected -or $expected -ne $actual) {
      Fail "the download does not match the release's checksum, so it was not installed. Try again; if it keeps happening, report it at https://github.com/$repo/issues"
    }

    $unpacked = Join-Path $tmp 'unpacked'
    try {
      # .NET's own unzip, for the same reason as Get-Sha256.
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [IO.Compression.ZipFile]::ExtractToDirectory($archive, $unpacked)
    } catch {
      Fail "the download could not be unpacked. $($_.Exception.Message)"
    }
    $new = Join-Path $unpacked 'loomwatch'
    foreach ($part in @('bin\loomwatchd.exe', 'LoomWatch.exe', 'loomwatch.cmd', 'scripts\loomwatch.ps1')) {
      if (-not (Test-Path -LiteralPath (Join-Path $new $part))) { Fail 'the download is missing parts of LoomWatch.' }
    }

    $version = ''
    $versionFile = Join-Path $new 'VERSION'
    if (Test-Path -LiteralPath $versionFile) { $version = ([IO.File]::ReadAllText($versionFile).Trim() -split ' ')[0] }
    Step "Installing LoomWatch $version in $(Pretty $appDir)"
    $replaced = Join-Path $tmp 'replaced'
    New-Item -ItemType Directory -Force -Path $appDir, $replaced | Out-Null
    # Every packaged file and folder replaces its old copy. Anything else in the folder stays: the
    # running state and the version kept from the last update. When one cannot be moved (a file
    # still open, say), the ones already moved go back, so the copy there is left as it was.
    $placed = New-Object System.Collections.Generic.List[string]
    foreach ($item in Get-ChildItem -LiteralPath $new -Force) {
      $target = Join-Path $appDir $item.Name
      try {
        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination (Join-Path $replaced $item.Name) }
        Move-Item -LiteralPath $item.FullName -Destination $target
        $placed.Add($item.Name)
      } catch {
        foreach ($name in $placed) { Remove-Item -LiteralPath (Join-Path $appDir $name) -Recurse -Force -ErrorAction SilentlyContinue }
        foreach ($old in Get-ChildItem -LiteralPath $replaced -Force) {
          Move-Item -LiteralPath $old.FullName -Destination (Join-Path $appDir $old.Name) -ErrorAction SilentlyContinue
        }
        Fail "LoomWatch could not be put in place in $(Pretty $appDir), so the version there was left as it was. $($_.Exception.Message)"
      }
    }
    # The version just replaced, kept whole for `loomwatch rollback` until the next update.
    if (Get-ChildItem -LiteralPath $replaced -Force | Select-Object -First 1) {
      $previous = Join-Path $appDir '.previous'
      if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
      Move-Item -LiteralPath $replaced -Destination $previous
    }

    # The `loomwatch` command, for the usual install only: its folder on this account's own PATH,
    # which every terminal opened from now on reads.
    $runWith = "& '$(Join-Path $appDir 'loomwatch.cmd')'"
    $usual = Join-Path $homeFolder 'LoomWatch\app'
    if ($appDir -eq $usual) {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      $entries = @()
      if ($userPath) { $entries = @($userPath -split ';' | Where-Object { $_ }) }
      if (-not ($entries | Where-Object { $_.TrimEnd('\') -eq $appDir })) {
        [Environment]::SetEnvironmentVariable('Path', (@($entries) + $appDir) -join ';', 'User')
        Say "Added $(Pretty $appDir) to your PATH, so new terminal windows know the loomwatch command."
      }
      $runWith = 'loomwatch'
    }

    if ($Update) {
      $label = $version
      if (-not $label) { $label = 'the newest release' }
      Say "Updated LoomWatch to $label."
      return
    }
    Say "Installed. Start LoomWatch at any time with: $runWith (in a new terminal window)"
    Say "Update it with: $runWith update. Remove it with the steps at https://github.com/$repo#remove-loomwatch"
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not $start) { return }
  # This window does not know the new PATH yet, so the launcher is started by its full path.
  & (Join-Path $appDir 'loomwatch.cmd')
}

Install-LoomWatch -NoStart:$NoStart -Update:$Update -Latest:$Latest -Dir $Dir
