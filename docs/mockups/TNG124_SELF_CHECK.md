# TNG-124 capability-library polish and reachability fix — focused self-check

Final revision: `ba8d224`
Artifact: `docs/mockups/prototype-standalone.html`
Exact size: **594,130 bytes**
SHA-256: `6acd73c78fdce698d83a26efb7753591cb66702b2436de9373412074cdc15c64`

## Board rejection this responds to

> recheck the library UI. I don't feel it is aesthetic enough. Also, I cannot drag and drop
> everything in the library sidebar

(Interaction `95fe361b-c654-492f-b74d-78099b985cc3` on TNG-87, resolved `rejected`.)

## Result

**PASS** — `node docs/mockups/verify-prototype.mjs` (unchanged existing suite, re-run clean
after this revision)

## Diagnosis, not guesswork

Both complaints were traced to measured defects in headless Chrome before any CSS was
touched, using the *actual* `prototype-standalone.html`, not a description of it:

- **Row overflow.** `.lib-row` computed `height: 40px`; the three-line content stack
  (name + sub + state/wired badges, added by TNG-122/123 on top of the original two-line
  row) measured `49.5px`, rendering at `36.96px` with only `6px` to the next row —
  confirmed overflow, confirmed visual collision.
- **Reachability.** Every resource kind was already correctly wired to place on drop —
  confirmed by simulating a *real* native HTML5 drag through Chrome DevTools Protocol
  (`Input.setInterceptDrags` + `Input.dispatchDragEvent`, which drives Chrome's actual drag
  session, not a synthetic in-page `dispatchEvent(new DragEvent(...))`) for an agent, a
  skill, two tools, and two knowledge sources: all six placed. The actual defect was that
  `#libGroups` (`.lib-scroll`) already had `scrollHeight` (1455) greater than `clientHeight`
  (614) **even in the default collapsed-Tools state**, with no visible scrollbar (macOS
  overlay scrollbars are invisible at rest) and no other cue that content continued below
  the fold — so rows past the fold were reachable in code but undiscoverable at the glass.

## Fix and re-verification

- `#library .lib-row` (scoped — the TNG-121 Available-team palette shares the `.lib-row`
  class but only ever shows two lines and already fit 40 px, so it is untouched) is now
  `min-height: 44px` with real padding; re-measured content no longer overflows the row
  (`overflowsRow: false`).
- `.lib-scroll` gained a persistent thin scrollbar thumb (`scrollbar-color` +
  `::-webkit-scrollbar`) and a scroll-position-driven edge fade (`.can-scroll-up` /
  `.can-scroll-down`), recomputed by `updateLibScrollFade()` on render, scroll, and resize —
  never a static decoration, so it cannot claim more content exists than actually does.
  Confirmed the classes flip correctly at `scrollTop = 0` and `scrollTop = max`, and that the
  last row in the catalogue (`r-know-meet`) becomes hit-testable at its own coordinates only
  once scrolled into view — i.e. the fix makes the true, always-scrollable state visible
  rather than changing what was reachable.
- Re-ran the same six-resource native-drag probe after the fix, this time scrolling each
  target row into view first (`scrollIntoView`) the way a reviewer actually would: agent,
  skill, two tools, two knowledge sources all placed, and the dragged row correctly carried
  the new `.dragging` state through the gesture.
- General card polish: bordered/tinted rows, circular monogram for capabilities vs. square
  for agents (shape carries the kind distinction, not color, so it survives the greyscale
  proof), pill-style group counts, a hairline divider between groups.

## Regression caught and fixed before this revision landed

The first pass of the row-height fix applied `min-height: 44px` to the bare `.lib-row`
class, which the TNG-121 Available-team palette (`#palettePanel .pp-row`) also uses. That
grew the palette panel enough to overlap the response card, failing the existing
`verify-prototype.mjs` overflow probe (`palette overlaps the response card`). Rescoped the
box-model change to `#library .lib-row` specifically; the full suite passed clean after.

## Themes, responsive, offline

Screenshotted (not just asserted) at 1600×1000 in both Quarry Light and Obsidian & Gilt, and
at 390×844: rows read as distinct cards with legible hierarchy in both themes, the edge fade
is visible against both the near-black and warm-paper grounds, and the 390 px bounded-drawer
library shows no horizontal overflow. `verify-prototype.mjs` re-passed its full existing
scope (causal graph, editable pipeline, freeform placement + typed wiring, capability library
states, planned-vs-observed separation, both themes, narrow layout, reduced motion, replay,
retry retention, offline loading) with zero new failures.

## Not verified here

- No new automated assertions were added to `verify-prototype.mjs` for the scroll-fade
  classes or the native-drag reachability probe — those were verified with one-off CDP
  scripts during this revision and are not checked into the repository. If a future revision
  touches this panel again, consider porting the `Input.dispatchDragEvent` technique into
  the permanent suite so "every kind is actually draggable" stops depending on a person
  remembering to scroll first.
- No new contrast measurements were taken; the row background/border changes use existing
  tier-2/tier-3 tokens already verified in `DESIGN_LANGUAGE.md §16`.

Design-only. `TNG89_INTERACTION.md §14.7` and `TNG122_FREEFORM_CAPABILITY_COMPOSER.md`
backend/schema assumptions are unchanged by this revision — no new node type, edge type, or
endpoint is introduced.
