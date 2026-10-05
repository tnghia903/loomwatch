#!/usr/bin/env bash
# Packs a built loomwatchd into the file scripts/install.sh downloads from a release.
#
#   scripts/package-release.sh PLATFORM LOOMWATCHD OUT_DIR
#
# writes OUT_DIR/loomwatch-PLATFORM.tar.gz and OUT_DIR/loomwatch-PLATFORM.tar.gz.sha256. PLATFORM
# is macos-universal, linux-x86_64 or linux-arm64, matching what install.sh asks for, or
# windows-x86_64, which install.ps1 asks for as loomwatch-windows-x86_64.zip with loomwatchd.exe.
# The program already holds the browser app, the database migrations and the team schema; the
# archive adds the launcher, the database's Compose file, the offline demo team and the licenses.
#
# The archive's names never change between releases, so the installer can always ask GitHub for
# releases/latest/download/loomwatch-PLATFORM.tar.gz (or .zip).
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: scripts/package-release.sh PLATFORM LOOMWATCHD OUT_DIR" >&2
  exit 2
fi
platform=$1
program=$2
out=$3
case $platform in
  macos-universal | linux-x86_64 | linux-arm64) windows=0 ;;
  windows-x86_64) windows=1 ;;
  *) echo "package-release.sh: unknown platform '$platform'" >&2; exit 2 ;;
esac
[ -f "$program" ] || { echo "package-release.sh: $program is not a file" >&2; exit 2; }
if [ "$windows" = 0 ] && [ ! -x "$program" ]; then
  echo "package-release.sh: $program is not an executable" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$root/crates/loomwatch-backend/Cargo.toml" | head -n 1)
commit=$(git -C "$root" rev-parse --short=7 HEAD)
[ -n "$version" ] || { echo "package-release.sh: no version in crates/loomwatch-backend/Cargo.toml" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
pkg=$stage/loomwatch
mkdir -p "$pkg/bin" "$pkg/examples"

cp "$root/docker-compose.yml" "$root/.env.example" "$root/LICENSE-MIT" "$root/LICENSE-APACHE" "$pkg/"
cp "$root/examples/operator-stop.yaml" "$root/examples/operator-stop-harness.py" "$pkg/examples/"
# "<version> <commit>": the installer shows the first, and the launcher reports the second in
# Send feedback, as a copy of the source reports its checkout.
printf '%s %s\n' "$version" "$commit" >"$pkg/VERSION"
if [ "$windows" = 1 ]; then
  # loomwatch.cmd starts scripts\loomwatch.ps1; Windows keeps no execute bit, and batch files and
  # Notepad want Windows line ends.
  mkdir -p "$pkg/scripts"
  cp "$program" "$pkg/bin/loomwatchd.exe"
  cp "$root/scripts/install.ps1" "$pkg/"
  cp "$root/scripts/loomwatch.ps1" "$pkg/scripts/"
  sed 's/\r*$/\r/' "$root/loomwatch.cmd" >"$pkg/loomwatch.cmd"
  sed 's/$/\r/' >"$pkg/README.txt" <<EOF
LoomWatch $version

Start LoomWatch with "loomwatch" in a new terminal window (or loomwatch.cmd in this folder), stop it
with Ctrl+C, update it with "loomwatch update", and see every option with "loomwatch help". It
needs Docker Desktop for its database and, for real runs, one of your AI apps.

The guide, the FAQ and how to remove LoomWatch are at https://github.com/tnghia903/loomwatch.

LoomWatch is licensed under the MIT License or the Apache License 2.0, at your option. Notices for
the open-source software inside it are served by the running app at /third-party-notices.txt.
EOF
else
  cp "$program" "$pkg/bin/loomwatchd"
  cp "$root/loomwatch" "$root/scripts/install.sh" "$pkg/"
  chmod 755 "$pkg/bin/loomwatchd" "$pkg/loomwatch" "$pkg/install.sh" "$pkg/examples/operator-stop-harness.py"
  cat >"$pkg/README.md" <<EOF
# LoomWatch $version

Start LoomWatch with \`./loomwatch\` in this folder (or \`~/LoomWatch/app/loomwatch\` from anywhere),
stop it with Ctrl-C, update it with \`./loomwatch update\`, and see every option with
\`./loomwatch help\`. It needs Docker for its database and, for real runs, one of your AI apps.

The guide, the FAQ and how to remove LoomWatch are at https://github.com/tnghia903/loomwatch.

LoomWatch is licensed under the MIT License or the Apache License 2.0, at your option. Notices for
the open-source software inside it are served by the running app at /third-party-notices.txt.
EOF
fi

mkdir -p "$out"
out=$(cd "$out" && pwd)
if [ "$windows" = 1 ]; then
  archive="loomwatch-$platform.zip"
  # Python's zipfile is on every build machine, Windows ones included, unlike zip. It writes the
  # archive afresh, replacing one left by an earlier run.
  python=$(command -v python3 || command -v python) || { echo "package-release.sh: packing a zip needs Python" >&2; exit 1; }
  (cd "$stage" && "$python" -m zipfile -c "$out/$archive" loomwatch)
else
  archive="loomwatch-$platform.tar.gz"
  # No macOS resource-fork files (._*) or extended attributes in the archive.
  COPYFILE_DISABLE=1 tar -C "$stage" -czf "$out/$archive" loomwatch
fi
(
  cd "$out"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$archive"; else shasum -a 256 "$archive"; fi >"$archive.sha256"
)
echo "Packed $out/$archive ($version, $commit)"
