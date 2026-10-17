#!/usr/bin/env bash
# Redraws the .dmg window's picture from dmg-background.html into dmg/: background.png and
# background@2x.png with the "Open Anyway" note, for an app that is not notarized, and
# background-notarized.png and @2x without it. Run on a Mac after changing the HTML, the crew in
# dmg/crew or the fonts; the PNGs are committed so a release build needs no browser.
# scripts/package-macos-app.sh picks the pair, and dmgbuild joins each pair into one picture for
# normal and Retina screens.
#
# Set CHROME_BIN when Chrome is not at the standard path.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
chrome=${CHROME_BIN:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$here/dmg"
draw() { # NAME QUERY SCALE
  local suffix=""
  [ "$3" = 2 ] && suffix="@2x"
  local out="$here/dmg/$1$suffix.png"
  # The virtual time budget lets the fonts and the crew poster load before the shot.
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor="$3" \
    --window-size=720,500 --virtual-time-budget=5000 --user-data-dir="$work/profile" \
    --screenshot="$out" "file://$here/dmg-background.html$2" >/dev/null 2>&1
  [ "$(sips -g pixelWidth "$out" 2>/dev/null | awk '/pixelWidth/ { print $2 }')" = $((720 * $3)) ] ||
    { echo "Chrome did not draw $out" >&2; exit 1; }
  echo "wrote $out"
}
draw background "" 1
draw background "" 2
draw background-notarized "?notarized" 1
draw background-notarized "?notarized" 2
