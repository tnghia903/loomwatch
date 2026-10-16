#!/usr/bin/env bash
# Rebuilds packaging/macos/AppIcon.icns from AppIcon.svg and AppIcon-small.svg. Run on a Mac after changing
# either SVG; the .icns is committed so a release build needs no SVG renderer. The 16 and 32 px images come
# from the small mark (a bigger face and a coarser stitch), the rest from the large one.
#
# The SVGs are drawn by headless Chrome on a clear background. Quick Look (qlmanage) drew them on white,
# which left a white square behind the rounded tile. Set CHROME_BIN when Chrome is not at the standard path.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
chrome=${CHROME_BIN:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
draw() {
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --force-device-scale-factor=1 --window-size=1024,1024 --user-data-dir="$work/profile" \
    --screenshot="$work/$1.png" "file://$here/$1.svg" >/dev/null 2>&1
  [ -s "$work/$1.png" ] || { echo "Chrome did not draw $1.svg" >&2; exit 1; }
}
draw AppIcon
draw AppIcon-small
set=$work/AppIcon.iconset
mkdir -p "$set"
pick() { if [ "$1" -le 32 ]; then echo "$work/AppIcon-small.png"; else echo "$work/AppIcon.png"; fi; }
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$(pick "$size")" --out "$set/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$(pick "$double")" --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o "$here/AppIcon.icns"
echo "wrote $here/AppIcon.icns"
