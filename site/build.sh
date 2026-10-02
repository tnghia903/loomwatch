#!/usr/bin/env bash
# Assemble the landing page for GitHub Pages: the page in site/, plus the README's screenshots and
# the design system's fonts, which are read from where they already live rather than copied into
# site/ a second time. The Pages workflow runs this; run it yourself to preview the page.
#
#   site/build.sh            # writes ./_site
#   site/build.sh /tmp/page  # writes there
#   python3 -m http.server -d _site 4173
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/_site}
case "$out" in
  "" | / | "$root" | "$HOME") echo "site/build.sh: refusing to write to $out" >&2; exit 1 ;;
esac

rm -rf "$out"
mkdir -p "$out/assets/readme" "$out/assets/fonts"
cp "$root"/site/index.html "$root"/site/styles.css "$root"/site/main.js "$root"/site/favicon.svg "$out/"
cp "$root"/docs/assets/readme/*.png "$out/assets/readme/"
cp "$root"/docs/design-system/fonts/fonts.css "$root"/docs/design-system/fonts/*.woff2 "$out/assets/fonts/"
echo "Built the landing page in $out"
