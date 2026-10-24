#!/usr/bin/env bash
# Assemble the landing page for GitHub Pages: the page in site/, plus the README's screenshots, the
# agent figures and the app's fonts, which are read from where they already live rather than copied
# into site/ a second time. The Pages workflow runs this; run it yourself to preview the page.
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
# Absolute from here on: the live figures are built from inside ui/, and the Pages workflow passes
# a relative folder (_site).
out=$(cd "$out" && pwd -P)
cp "$root"/site/index.html "$root"/site/styles.css "$root"/site/main.js "$root"/site/learn.js "$out/"
# The guides: site/<guide>/index.html is served at https://loomwatch.github.io/<guide>/, in the
# landing page's styles.css with guides.css and guides.js of their own.
for page in "$root"/site/*/index.html; do
  guide=$(basename "$(dirname "$page")")
  mkdir -p "$out/$guide"
  cp "$page" "$out/$guide/"
done
cp "$root"/site/guides.css "$root"/site/guides.js "$out/"
# favicon.ico and apple-touch-icon.png are rendered from favicon.svg by site/icons.mjs.
cp "$root"/site/favicon.svg "$root"/site/favicon.ico "$root"/site/apple-touch-icon.png "$out/"
# The link preview picture (og:image); site/social-card.html says how it is made.
cp "$root"/site/social-card.jpg "$out/"
# For search engines: robots.txt names the sitemap, and the sitemap names every page and the day it
# last changed.
cp "$root"/site/robots.txt "$out/"
"$root"/site/sitemap.sh "$out"
# Google Search Console's proof that the site is ours: the google….html file it asked for, served at
# the top of the site. Keep it there, or Google stops trusting the site's owner.
cp "$root"/site/google*.html "$out/"
cp "$root"/docs/assets/readme/*.png "$out/assets/readme/"
# The app's own screenshots for the page, the crew in the cold open, and the agent figures, read
# from the app so the page shows the same faces the app does.
mkdir -p "$out/assets/app" "$out/assets/crew" "$out/assets/figures"
cp "$root"/site/assets/app/*.webp "$out/assets/app/"
cp "$root"/site/assets/crew/*.webp "$out/assets/crew/"
cp "$root"/ui/public/agent/figures/*.webp "$out/assets/figures/"
# The live figures: the app's own 3D figure code (ui/src/site/landingLive.ts), built with three.js
# into live.js and a module of the bench's own, and the model it draws. Needs ui's packages (pnpm
# install in ui/).
(cd "$root/ui" && LANDING_LIVE_OUT="$out/assets/live" pnpm exec vite build --config vite.site.config.ts --logLevel warn)
# The model, compressed for the download (311 KB gzipped → 104 KB) with meshopt; readModel decodes it.
# Positions and UVs stay floats (-vpf -vtf): quantized positions move each mesh under a new unnamed
# node, and quantized UVs come out at 1/16 scale in a model with no textures to scale them back.
# -kn -km -ke -kv keep the node names, materials, extras and UVs the scenes look things up by.
# ui/public/agent/workbench.glb stays as made: the app reads it, and scripts/figures/merge.py edits it.
(cd "$root/ui" && pnpm exec gltfpack -i public/agent/workbench.glb -o "$out/assets/live/workbench.glb" -cc -vpf -vtf -kn -km -ke -kv > /dev/null)
# The app's own font files and @font-face rules, so the page and the app set type in the same fonts.
# The fonts' license (SIL OFL) has to travel with every copy of them.
cp "$root"/ui/public/fonts/fonts.css "$root"/ui/public/fonts/*.woff2 "$root"/ui/public/fonts/OFL.txt "$out/assets/fonts/"
echo "Built the landing page in $out"
