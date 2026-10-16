#!/usr/bin/env bash
# Rebuilds packaging/macos/AppIcon.icns from AppIcon.svg. Run on a Mac after changing the SVG;
# the .icns is committed so a release build needs no SVG renderer.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
qlmanage -t -s 1024 -o "$work" "$here/AppIcon.svg" >/dev/null
set=$work/AppIcon.iconset
mkdir -p "$set"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$work/AppIcon.svg.png" --out "$set/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$work/AppIcon.svg.png" --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o "$here/AppIcon.icns"
echo "wrote $here/AppIcon.icns"
