#!/usr/bin/env bash
# Builds LoomWatch.app and the LoomWatch-macos.dmg people download, from three built programs.
#
#   scripts/package-macos-app.sh LOOMWATCHD LOOMWATCH_APP LOOMWATCH_OSASCRIPT OUT_DIR
#
# LOOMWATCHD is a built loomwatchd (with the UI built into it), LOOMWATCH_APP the built
# `LoomWatch` program from crates/loomwatch-app, and LOOMWATCH_OSASCRIPT the built
# `loomwatch-osascript` from crates/loomwatch-osascript, which loomwatchd signs a copy of for agents'
# commands (ADR 0087); all may be universal. Writes OUT_DIR/LoomWatch-macos.dmg and
# OUT_DIR/LoomWatch-macos.dmg.sha256.
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

[ $# -eq 4 ] || { echo "usage: $0 LOOMWATCHD LOOMWATCH_APP LOOMWATCH_OSASCRIPT OUT_DIR" >&2; exit 2; }
dmgbuild=${DMGBUILD:-$(command -v dmgbuild || true)}
[ -x "$dmgbuild" ] || {
  echo "$0: needs dmgbuild; see packaging/macos/dmgbuild-requirements.txt, or set DMGBUILD" >&2
  exit 2
}
daemon=$1
app_program=$2
osascript_program=$3
out=$4
root=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$root/crates/loomwatch-backend/Cargo.toml" | head -n 1)
[ -n "$version" ] || { echo "$0: no version in crates/loomwatch-backend/Cargo.toml" >&2; exit 1; }
commit=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
app=$stage/LoomWatch.app
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$app_program" "$app/Contents/MacOS/LoomWatch"
cp "$daemon" "$app/Contents/MacOS/loomwatchd"
cp "$osascript_program" "$app/Contents/MacOS/loomwatch-osascript"
chmod 755 "$app/Contents/MacOS/LoomWatch" "$app/Contents/MacOS/loomwatchd" \
  "$app/Contents/MacOS/loomwatch-osascript"
cp "$root/packaging/macos/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
cp "$root/LICENSE-MIT" "$root/LICENSE-APACHE" "$root/TRADEMARKS.md" "$app/Contents/Resources/"
printf '%s %s\n' "$version" "$commit" >"$app/Contents/Resources/VERSION"

sed "s/@VERSION@/$version/g" "$root/packaging/macos/Info.plist" >"$app/Contents/Info.plist"
plutil -lint -s "$app/Contents/Info.plist"

if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  # Inside out: the helper programs first, then the app around them. Under the hardened runtime,
  # macOS asks before agents work in another app only for programs entitled to send Apple Events.
  # Only the app itself may use the microphone, to listen while ⌃⌥Space is held at the notch;
  # loomwatchd, which runs the agents' commands, may not.
  entitlements=$root/packaging/macos/LoomWatch.entitlements
  app_entitlements=$root/packaging/macos/LoomWatch-app.entitlements
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" \
    "$app/Contents/MacOS/loomwatch-osascript"
  codesign --force --options runtime --timestamp --entitlements "$entitlements" \
    --sign "$MACOS_SIGN_IDENTITY" "$app/Contents/MacOS/loomwatchd"
  codesign --force --options runtime --timestamp --entitlements "$app_entitlements" \
    --sign "$MACOS_SIGN_IDENTITY" "$app"
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
