#!/usr/bin/env bash
# Gathers the files LoomWatch-windows-setup.exe installs, from a built loomwatchd.exe and
# LoomWatch.exe, into the archive scripts/package-windows-app.ps1 builds the installer from.
#
#   scripts/package-release.sh windows-x86_64 LOOMWATCHD OUT_DIR APP
#
# writes OUT_DIR/loomwatch-windows-x86_64.zip and its .sha256. The program already holds the
# browser app, the database (SQLite, built in), its migrations and the team schema; the archive
# adds LoomWatch.exe, the app people open from the Start menu (give it as APP), and the licenses.
# The archive itself is not published: people install LoomWatch with the installer, or on a Mac
# with LoomWatch-macos.dmg (scripts/package-macos-app.sh).
set -euo pipefail

if [ $# -ne 4 ]; then
  echo "usage: scripts/package-release.sh windows-x86_64 LOOMWATCHD OUT_DIR APP" >&2
  exit 2
fi
platform=$1
program=$2
out=$3
app=$4
case $platform in
  windows-x86_64) ;;
  *) echo "package-release.sh: unknown platform '$platform': only windows-x86_64 is packed here" >&2; exit 2 ;;
esac
[ -f "$program" ] || { echo "package-release.sh: $program is not a file" >&2; exit 2; }
[ -f "$app" ] || { echo "package-release.sh: $app is not a file (LoomWatch.exe)" >&2; exit 2; }

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$root/crates/loomwatch-backend/Cargo.toml" | head -n 1)
commit=$(git -C "$root" rev-parse --short=7 HEAD)
[ -n "$version" ] || { echo "package-release.sh: no version in crates/loomwatch-backend/Cargo.toml" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
pkg=$stage/loomwatch
mkdir -p "$pkg/bin"

cp "$root/LICENSE-MIT" "$root/LICENSE-APACHE" "$root/TRADEMARKS.md" "$pkg/"
# "<version> <commit>": the app reports the second in Send feedback.
printf '%s %s\n' "$version" "$commit" >"$pkg/VERSION"
cp "$program" "$pkg/bin/loomwatchd.exe"
cp "$app" "$pkg/LoomWatch.exe"
# Notepad wants Windows line ends.
sed 's/$/\r/' >"$pkg/README.txt" <<TEXT
LoomWatch $version

Open LoomWatch from the Start menu: it opens in your browser and keeps an icon beside the clock,
whose menu has Quit. It keeps its run history in one file on this computer and needs nothing else
installed.

The guide, the FAQ and how to remove LoomWatch are at https://github.com/tnghia903/loomwatch.

LoomWatch is licensed under the MIT License or the Apache License 2.0, at your option. Notices for
the open-source software inside it are served by the running app at /third-party-notices.txt.
TEXT

mkdir -p "$out"
out=$(cd "$out" && pwd)
archive="loomwatch-$platform.zip"
# Python's zipfile is on every build machine, Windows ones included, unlike zip. It writes the
# archive afresh, replacing one left by an earlier run.
python=$(command -v python3 || command -v python) || { echo "package-release.sh: packing a zip needs Python" >&2; exit 1; }
(cd "$stage" && "$python" -m zipfile -c "$out/$archive" loomwatch)
(
  cd "$out"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$archive"; else shasum -a 256 "$archive"; fi >"$archive.sha256"
)
echo "Packed $out/$archive ($version, $commit)"
