#!/usr/bin/env bash
# Rebuilds packaging/windows/LoomWatch.ico, LoomWatch.exe's icon (Start menu, taskbar, File Explorer,
# the notification area), from docs/assets/brand/mark.svg and mark-small.svg. Run on a Mac after
# changing either; the .ico is committed so a release build needs no SVG renderer. The sizes up to
# 40 px come from the small mark (a bigger face and a coarser stitch), the rest from the large one,
# and every size is its own image, as Windows picks the one nearest what it shows.
#
# The SVGs are drawn by headless Chrome on a clear background, as packaging/macos/make-icon.sh
# draws them. Set CHROME_BIN when Chrome is not at the standard path.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
brand=$(cd "$here/../../docs/assets/brand" && pwd)
chrome=${CHROME_BIN:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
draw() {
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --force-device-scale-factor=1 --window-size=1024,1024 --user-data-dir="$work/profile" \
    --screenshot="$work/$1.png" "file://$brand/$1.svg" >/dev/null 2>&1
  [ -s "$work/$1.png" ] || { echo "Chrome did not draw $1.svg" >&2; exit 1; }
}
draw mark
draw mark-small
sizes="16 20 24 32 40 48 64 128 256"
for size in $sizes; do
  if [ "$size" -le 40 ]; then from=mark-small; else from=mark; fi
  sips -z "$size" "$size" "$work/$from.png" --out "$work/$size.png" >/dev/null
done
# An .ico is a directory of images; Windows Vista and later read PNG ones.
python3 - "$here/LoomWatch.ico" "$work" $sizes <<'PY'
import struct, sys
out, work, sizes = sys.argv[1], sys.argv[2], [int(s) for s in sys.argv[3:]]
images = [open(f"{work}/{s}.png", "rb").read() for s in sizes]
head = struct.pack("<HHH", 0, 1, len(images))
offset = len(head) + 16 * len(images)
for size, png in zip(sizes, images):
    # 0 means 256 in the one-byte width and height.
    head += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset)
    offset += len(png)
open(out, "wb").write(head + b"".join(images))
PY
echo "wrote $here/LoomWatch.ico"
