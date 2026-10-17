# dmgbuild settings for LoomWatch-macos.dmg: the window people see when they open it. Read by
# scripts/package-macos-app.sh as `dmgbuild -s packaging/macos/dmg-settings.py -D app=APP
# -D background=PNG -D icon=ICNS LoomWatch OUT.dmg`.
#
# The icon positions and size here are the points dmg-background.html draws its patches and name
# tags around: change them together, then re-run make-dmg-background.sh.

# dmgbuild runs this file with `defines` set from the -D options.
app = defines["app"]  # noqa: F821
background = defines["background"]  # noqa: F821
# The disk's own icon, in the title bar and on the desktop while it is open.
icon = defines["icon"]  # noqa: F821

files = [app]
# No hide_extensions: it sets Finder info on the app bundle, which breaks `codesign --verify
# --strict`, and Finder hides ".app" already.
symlinks = {"Applications": "/Applications"}

format = "UDZO"
filesystem = "HFS+"

# 720 × 480 points under a 32-point title bar (macOS 26 and 27); the picture is 20 points taller,
# for a shorter title bar.
window_rect = ((200, 120), (720, 512))
default_view = "icon-view"
show_status_bar = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 128
text_size = 13
icon_locations = {
    "LoomWatch.app": (170, 200),
    "Applications": (550, 200),
}
