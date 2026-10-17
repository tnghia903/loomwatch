# Builds LoomWatch-windows-setup.exe, the installer people download and open on Windows, from the
# packed release (scripts/package-release.sh windows-x86_64 ...), so both ways of installing put
# the same files in place.
#
#   scripts/package-windows-app.ps1 -Zip dist\loomwatch-windows-x86_64.zip -Out dist
#
# writes Out\LoomWatch-windows-setup.exe and its .sha256. Needs Inno Setup 6 (ISCC.exe): on
# PATH, in its usual folder, or installed with `choco install innosetup` (GitHub's Windows runners
# have Chocolatey). packaging/windows/LoomWatch.iss says what the installer does.
param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$root = Split-Path -Parent $PSScriptRoot
$Zip = (Resolve-Path -LiteralPath $Zip).Path
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path

function Find-Iscc {
  $onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { return $onPath.Source }
  foreach ($folder in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
    if (-not $folder) { continue }
    $candidate = Join-Path $folder 'Inno Setup 6\ISCC.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

$iscc = Find-Iscc
if (-not $iscc -and (Get-Command choco -ErrorAction SilentlyContinue)) {
  & choco install innosetup --no-progress -y | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Chocolatey could not install Inno Setup.' }
  $iscc = Find-Iscc
}
if (-not $iscc) { throw 'Inno Setup 6 is needed: https://jrsoftware.org/isdl.php (or choco install innosetup).' }

$stage = Join-Path ([IO.Path]::GetTempPath()) ("loomwatch-setup-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
try {
  Expand-Archive -LiteralPath $Zip -DestinationPath $stage
  $files = Join-Path $stage 'loomwatch'
  foreach ($part in @('LoomWatch.exe', 'bin\loomwatchd.exe', 'VERSION')) {
    if (-not (Test-Path -LiteralPath (Join-Path $files $part))) { throw "$Zip has no $part." }
  }
  $version = ([IO.File]::ReadAllText((Join-Path $files 'VERSION')).Trim() -split ' ')[0]
  $script = Join-Path $root 'packaging\windows\LoomWatch.iss'
  & $iscc /Qp "/DVersion=$version" "/DStage=$files" "/DOutput=$Out" $script | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup could not build the installer (exit $LASTEXITCODE)." }
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

$setup = Join-Path $Out 'LoomWatch-windows-setup.exe'
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLowerInvariant()
# The same "<hash>  <name>" line sha256sum writes, without a byte-order mark.
[IO.File]::WriteAllText("$setup.sha256", "$hash  LoomWatch-windows-setup.exe`n")
Write-Host "Packed $setup ($version, $([math]::Round((Get-Item -LiteralPath $setup).Length / 1MB, 1)) MB)"
