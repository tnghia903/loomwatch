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
cp "$root"/site/index.html "$root"/site/styles.css "$root"/site/main.js "$out/"
# The use cases page, the one run it tells, and the team files it offers for download,
# read from examples/ so the page always serves the files that are in the repository.
cp "$root"/site/usecases.html "$root"/site/usecases.css "$root"/site/usecases.js "$root"/site/usecases-run.json "$out/"
mkdir -p "$out/usecases" "$out/assets/usecases"
cp "$root"/docs/assets/usecases/*.png "$out/assets/usecases/"
cp "$root"/examples/usecases/*.yaml "$out/usecases/"
cp -R "$root"/examples/usecases/*.brief "$out/usecases/"
# The installer the page tells people to run: curl -fsSL https://loomwatch.github.io/install.sh | bash
cp "$root"/scripts/install.sh "$out/install.sh"
# favicon.ico and apple-touch-icon.png are rendered from favicon.svg by site/icons.mjs.
cp "$root"/site/favicon.svg "$root"/site/favicon.ico "$root"/site/apple-touch-icon.png "$out/"
# The link preview picture (og:image); site/social-card.html says how it is made.
cp "$root"/site/social-card.jpg "$out/"
cp "$root"/docs/assets/readme/*.png "$out/assets/readme/"
# The fonts' license (SIL OFL) has to travel with every copy of them.
cp "$root"/docs/design-system/fonts/fonts.css "$root"/docs/design-system/fonts/*.woff2 "$root"/docs/design-system/fonts/OFL.txt "$out/assets/fonts/"
echo "Built the landing page in $out"
