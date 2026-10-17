#!/usr/bin/env bash
# Write sitemap.xml, for search engines, into the folder site/build.sh builds: the landing page and
# every guide (site/<guide>/index.html, served at https://loomwatch.github.io/<guide>/), each with
# the day it last changed. ui/src/site/seo.test.ts runs it too, and checks that it names every
# page's canonical address and nothing else.
#
#   site/sitemap.sh _site    # writes _site/sitemap.xml
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?usage: site/sitemap.sh <folder>}
site=https://loomwatch.github.io/

# The day of the last commit that changed these paths (all of them when none are named), or today
# outside a git checkout or for a page not committed yet.
changed() { git -C "$root" log -1 --format=%cs -- "$@" 2>/dev/null | grep . || date -u +%F; }
url() { printf '  <url>\n    <loc>%s</loc>\n    <lastmod>%s</lastmod>\n  </url>\n' "$1" "$2"; }

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  # The landing page draws on files all over the repository, so it is dated by the commit the site
  # is built from (Pages builds only when one of them changes). A guide is dated by its own page.
  url "$site" "$(changed)"
  for page in "$root"/site/*/index.html; do
    guide=$(basename "$(dirname "$page")")
    url "$site$guide/" "$(changed "site/$guide")"
  done
  echo '</urlset>'
} >"$out/sitemap.xml"
