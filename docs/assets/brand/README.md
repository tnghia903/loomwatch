# The LoomWatch logo

Every agent in LoomWatch wears a sewing-box figure, and they all share one face: two upright
eyes and a small gold stitch for a mouth. The mark is that face on its own, sewn onto a dark tile
with a gold running stitch. The eyes are warp threads, the mouth is the gold weft, and the stitch
makes it a patch of cloth rather than a screen, so it does not read as another bot icon.

The wordmark is "loomwatch" in lowercase, drawn with one round-capped thread, the same stroke as
the eyes. It is outlined artwork, not a font. The crossbar of the t is the gold weft again.

| File | Use it for |
| --- | --- |
| `mark.svg` | the mark at 48 px and up: app icon, social card, README |
| `mark-small.svg` | the mark at 40 px and below: favicons, headers, the menu bar. Its face is bigger and its stitch coarser, so both still read |
| `wordmark-dark.svg`, `wordmark-light.svg` | the name on a dark or a light ground |
| `lockup-dark.svg`, `lockup-light.svg` | mark and name together |

Colours: tile `#08080A`, eyes `#F5F3EE`, mouth `#E9C46A`, stitch `#D8A93C`. The tile stays dark
on light grounds too. On light grounds the wordmark is `#17150F` and its crossbar `#8A6A16`.

These files are the masters. `ui/public/icon.svg`, `ui/public/favicon.svg` and `site/favicon.svg`
are copies of `mark-small.svg`, and the app's `LoomMark` and `LoomWordmark` draw the same paths;
`ui/src/site/brand.test.ts` fails when a copy drifts. After changing a master, also run
`node site/icons.mjs`, `packaging/macos/make-icon.sh`, and re-render `site/social-card.html`.

The licenses cover the code, not the LoomWatch name or logo.
