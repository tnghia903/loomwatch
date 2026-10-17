#!/usr/bin/env bash
# Builds LoomWatch.app and the LoomWatch-macos.dmg people download, from two built programs.
#
#   scripts/package-macos-app.sh LOOMWATCHD LOOMWATCH_APP OUT_DIR
#
# LOOMWATCHD is a built loomwatchd (with the UI built into it) and LOOMWATCH_APP the built
# `LoomWatch` program from crates/loomwatch-app; both may be universal. Writes
# OUT_DIR/LoomWatch-macos.dmg and OUT_DIR/LoomWatch-macos.dmg.sha256.
#
# Signing, from the environment:
#   MACOS_SIGN_IDENTITY  a "Developer ID Application: …" identity in the keychain. Without it the
#                        app is signed ad hoc, and macOS asks people to allow it in System Settings
#                        the first time (Privacy & Security, "Open Anyway").
#   MACOS_NOTARY_PROFILE a `xcrun notarytool store-credentials` profile. With it (and an identity),
#                        the .dmg is notarized and stapled, so it opens with no warning at all.
#
# The .dmg's window is laid out by dmgbuild (https://github.com/dmgbuild/dmgbuild), found on PATH or
# given as DMGBUILD. Install the pinned copy with:
#   python3 -m venv .dmgbuild && .dmgbuild/bin/pip install --require-hashes -r packaging/macos/dmgbuild-requirements.txt
set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 LOOMWATCHD LOOMWATCH_APP OUT_DIR" >&2; exit 2; }
dmgbuild=${DMGBUILD:-$(command -v dmgbuild || true)}
[ -x "$dmgbuild" ] || {
  echo "$0: needs dmgbuild; see packaging/macos/dmgbuild-requirements.txt, or set DMGBUILD" >&2
  exit 2
}
daemon=$1
app_program=$2
out=$3
root=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$root/crates/loomwatch-backend/Cargo.toml" | head -n 1)
[ -n "$version" ] || { echo "$0: no version in crates/loomwatch-backend/Cargo.toml" >&2; exit 1; }
commit=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
app=$stage/LoomWatch.app
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/examples"
cp "$app_program" "$app/Contents/MacOS/LoomWatch"
cp "$daemon" "$app/Contents/MacOS/loomwatchd"
chmod 755 "$app/Contents/MacOS/LoomWatch" "$app/Contents/MacOS/loomwatchd"
cp "$root/packaging/macos/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
cp "$root/examples/operator-stop.yaml" "$app/Contents/Resources/examples/"
cp "$root/LICENSE-MIT" "$root/LICENSE-APACHE" "$root/TRADEMARKS.md" "$app/Contents/Resources/"
printf '%s %s\n' "$version" "$commit" >"$app/Contents/Resources/VERSION"

cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>LoomWatch</string>
  <key>CFBundleDisplayName</key><string>LoomWatch</string>
  <key>CFBundleIdentifier</key><string>io.github.loomwatch</string>
  <key>CFBundleExecutable</key><string>LoomWatch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <!-- A menu-bar app: no Dock icon. -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  # Inside out: the helper program first, then the app around it.
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$app/Contents/MacOS/loomwatchd"
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$app"
else
  codesign --force --deep --sign - "$app"
fi
codesign --verify --deep --strict "$app"

# The window people see when they open the .dmg: the app on its patch, a thread to Applications, and
# the crew below (packaging/macos/dmg-settings.py and dmg-background.html). Only an app that is
# notarized skips the note on getting past macOS's first-open check.
background=$root/packaging/macos/dmg/background.png
if [ -n "${MACOS_SIGN_IDENTITY:-}" ] && [ -n "${MACOS_NOTARY_PROFILE:-}" ]; then
  background=$root/packaging/macos/dmg/background-notarized.png
fi
mkdir -p "$out"
dmg=$out/LoomWatch-macos.dmg
rm -f "$dmg"
"$dmgbuild" -s "$root/packaging/macos/dmg-settings.py" -D app="$app" -D background="$background" \
  -D icon="$root/packaging/macos/AppIcon.icns" LoomWatch "$dmg"

if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$MACOS_SIGN_IDENTITY" "$dmg"
  if [ -n "${MACOS_NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$dmg" --keychain-profile "$MACOS_NOTARY_PROFILE" --wait
    xcrun stapler staple "$dmg"
  fi
fi

(cd "$out" && shasum -a 256 LoomWatch-macos.dmg >LoomWatch-macos.dmg.sha256)
echo "wrote $dmg ($(du -h "$dmg" | cut -f1))"
