#!/usr/bin/env bash
# Packs a built loomwatchd into the file scripts/install.sh downloads from a release.
#
#   scripts/package-release.sh PLATFORM LOOMWATCHD OUT_DIR
#
# writes OUT_DIR/loomwatch-PLATFORM.tar.gz and OUT_DIR/loomwatch-PLATFORM.tar.gz.sha256. PLATFORM
# is macos-universal, linux-x86_64 or linux-arm64, matching what install.sh asks for. The program
# already holds the browser app, the database migrations and the team schema; the archive adds the
# launcher, the database's Compose file, the offline demo team and the licenses.
#
# The archive's names never change between releases, so the installer can always ask GitHub for
# releases/latest/download/loomwatch-PLATFORM.tar.gz.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: scripts/package-release.sh PLATFORM LOOMWATCHD OUT_DIR" >&2
  exit 2
fi
platform=$1
program=$2
out=$3
case $platform in
  macos-universal | linux-x86_64 | linux-arm64) ;;
  *) echo "package-release.sh: unknown platform '$platform'" >&2; exit 2 ;;
esac
[ -x "$program" ] || { echo "package-release.sh: $program is not an executable" >&2; exit 2; }

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$root/crates/loomwatch-backend/Cargo.toml" | head -n 1)
commit=$(git -C "$root" rev-parse --short=7 HEAD)
[ -n "$version" ] || { echo "package-release.sh: no version in crates/loomwatch-backend/Cargo.toml" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
pkg=$stage/loomwatch
mkdir -p "$pkg/bin" "$pkg/examples"

cp "$program" "$pkg/bin/loomwatchd"
cp "$root/loomwatch" "$root/scripts/install.sh" "$pkg/"
cp "$root/docker-compose.yml" "$root/.env.example" "$root/LICENSE-MIT" "$root/LICENSE-APACHE" "$pkg/"
cp "$root/examples/operator-stop.yaml" "$root/examples/operator-stop-harness.py" "$pkg/examples/"
chmod 755 "$pkg/bin/loomwatchd" "$pkg/loomwatch" "$pkg/install.sh" "$pkg/examples/operator-stop-harness.py"
# "<version> <commit>": install.sh shows the first, and the launcher reports the second in
# Send feedback, as a copy of the source reports its checkout.
printf '%s %s\n' "$version" "$commit" >"$pkg/VERSION"
cat >"$pkg/README.md" <<EOF
# LoomWatch $version

Start LoomWatch with \`./loomwatch\` in this folder (or \`~/LoomWatch/app/loomwatch\` from anywhere),
stop it with Ctrl-C, update it with \`./loomwatch update\`, and see every option with
\`./loomwatch help\`. It needs Docker for its database and, for real runs, one of your AI apps.

The guide, the FAQ and how to remove LoomWatch are at https://github.com/tnghia903/loomwatch.

LoomWatch is licensed under the MIT License or the Apache License 2.0, at your option. Notices for
the open-source software inside it are served by the running app at /third-party-notices.txt.
EOF

mkdir -p "$out"
archive="loomwatch-$platform.tar.gz"
# No macOS resource-fork files (._*) or extended attributes in the archive.
COPYFILE_DISABLE=1 tar -C "$stage" -czf "$out/$archive" loomwatch
(
  cd "$out"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$archive"; else shasum -a 256 "$archive"; fi >"$archive.sha256"
)
echo "Packed $out/$archive ($version, $commit)"
