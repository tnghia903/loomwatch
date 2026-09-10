# TNG-87 "i cannot move these 3 items" — focused self-check

Responds to the board comment of 2026-09-10T11:12Z, screenshot attachment
`d58fd57b`:

> i cannot move these 3 items and also, their edge does not follow the node when I move the
> node. There are something wrong here

## Which three items, and on which screen

The screenshot shows `#01 · 02.1S Notion / workspace.search`, `#02 · 04.8S Launch brief /
knowledge search`, `#03 · 07.4S acme/loomwatch / repository · main`, with `EVIDENCE → RESPONSE`
to their right and `INVOKES` below. That is the observed provenance cluster on the **Freeform
wiring** screen and nothing else in the prototype:

- exactly three cards, which is `WIRE_OBSERVED.length`; the run screens project seven;
- `SUCCEEDED · Resear…` is `ownerA()` = "Researcher (Agent A)" clipped, which only the wiring
  screen renders (the run screens say "Agent A");
- the `evidence → response` label is emitted in `paintWiring()` alone.

Worth recording separately, because it revises a standing assumption in this issue's history:
**the board is no longer confined to the default `canvas` screen.** Three prior rounds were
reasoned about on the premise that they never reach `wiring`. They are there now.

## Result

**PASS** — 12/12 in WebKit, and the same probe scores **2/12** against the pre-fix build.

| gate | result |
| --- | --- |
| `webkit-probe-provenance-drag.js` (new) | 12/12 |
| same probe vs `git show HEAD~1:…standalone.html` | 10 failures — the reported defects |
| `verify-prototype.mjs` (headless Chrome) | full suite clean |
| `verify-webkit.swift` default pass A/B | 6/6 |
| `webkit-probe-library-gesture.js` | PASS |
| `webkit-probe-library-routing.js` | PASS |
| `webkit-probe-canvas-affordances.js` | unchanged (same 5 pre-existing findings) |

The pre-fix run is the part that matters: two of its twelve checks pass ("the node itself moved",
"the edges are correct after release"), so the ten failures are findings and not a probe that
fails everything it touches.

## The two defects, which were unrelated

**1. The three cards were not draggable at all.** Every other object on that coordinate graph —
planned nodes, dropped resources — answers press-drag-release through `bindWireNode`. The
observed cards were `<button>`s in a different layer (`#overlay`) whose only listener called
`announce()`. They carried `cursor: pointer`, so the pointer promised something, and pressing
one moved it 0px. Measured pre-fix: `moved 0px during the gesture, 0px still after repaint`,
three times.

**2. Observed edges were repainted on release, not during the drag.** `bindWireNode`'s
`pointermove` called `repaintEdges()`, which writes `#edgeGroup`, `#edgeLabels` and `#wireGroup`
— the *planned* layer. The observed layer (`#provGroup`) was only rebuilt by the full
`paintWiring()` on `pointerup`. So for the entire time a node was under the pointer, the blue
provenance lines stayed at the node's old position and then snapped. That is exactly "their edge
does not follow the node when I move the node", and it applied to both anchors: `wa1`, where
every observed edge starts, and `wr1`, where `evidence → response` lands.

Nothing before this measured mid-gesture. A probe that samples before and after a completed
drag reports every edge as correct and sees none of what the reviewer sees.

## A third defect found while fixing them: deleting a node froze the screen

`paintWiring()` dereferenced `wnode('wa1')` and `wnode('wr1')` unguarded while building the
observed paths, but both are ordinary nodes the operator can select and delete. Deleting the
researcher with evidence on screen threw
`TypeError: undefined is not an object (evaluating 'a1.x')` **inside** `paintWiring`, after
`#nodes` had been rewritten and before the wire strip was updated — so the screen was left
half-repainted and every subsequent repaint threw again. The screen stops responding to
everything, which is the worst possible version of "there are something wrong here".

Confirmed against the pre-fix build, not argued from reading:

```
FAIL deleting the researcher repaints instead of throwing (TypeError: undefined is not an object (evaluating 'a1.x'))
FAIL the screen keeps repainting afterwards — paintWiring completes to the wire strip
```

Every anchor in `provPathsHTML()` is now optional.

## What changed

- `obsPos(e)` — an observed card's position is its projected slot unless the operator has
  carried it. Moving one is a **view preference**: it never edits the event. Observed evidence
  is a record of what the run did, not document state the operator authors, and that boundary is
  the whole planned-vs-observed distinction the wiring screen exists to show.
- `provPathsHTML()` / `repaintProv()` — the observed layer's geometry, split out so it can be
  recomputed inside a gesture. `paintWiring()` cannot be called mid-drag: it rewrites `#nodes`
  and `#overlay` wholesale and tears the dragged element out from under the pointer. `repaintProv()`
  writes one SVG group and moves two labels, and is called from both drag paths' `pointermove`.
- `bindObsCard()` — the same press-drag-release contract as `bindWireNode`: 5px threshold,
  pointer capture, clamped to the 1600×1000 stage, selects on drop.
- Keyboard parity — arrow keys nudge a selected card 16px (64px with Shift), matching
  `nudgeSelected()` for planned nodes. The gesture is not mouse-only.
- Delete/`W`/`E`/`R` on a selected card now explain rather than no-op: *"Observed evidence
  records what the run did. It can be moved, but not removed or rewired."* Previously these fell
  through to the planned-graph handlers, which looked the id up in `wiring.nodes`, found nothing,
  and either did nothing silently (`Delete`) or threw (`E`).
- `cursor: grab` on the cards is scoped to `#stage.wiring-mode`. The identical card on the run
  screens opens the activity panel and does not move; a grab cursor there would promise a gesture
  that surface does not serve. In the ≤767px column layout, where there are no coordinates to
  place anything at, it reverts to `pointer`.
- The `evidence → response` edge now leaves the card's actual right edge. It was anchored at
  `WIRE_SIZES.res.w` (216px) on a card that is 180px wide, so it started 36px out in space —
  invisible while the card was pinned, obvious once it can be moved. Its label moved from a fixed
  `card.x + 320` to the midpoint of the edge it names, for the same reason: a fixed offset walks
  off the stage as soon as the card is carried to the right-hand side.
- `startObserve()` no longer pushes `undefined` when the projection timer fires after the
  observed list is already full. Not reachable by clicking — `wireReplay()` clears the timer
  first — but reachable from any script that fills `wiring.observed` directly, and the resulting
  `TypeError` surfaced as the prototype's own "failed to initialise" banner.

## The gate that should have caught this and did not

`webkit-probe-canvas-affordances.js` (landed by the concurrent session in `dd097eb`) sweeps
every affordance and asks "I pressed it — did anything happen?". Run against the wiring screen
it returns **the identical result before and after this fix**, and it never flagged the three
cards.

Because pressing one called `announce()`, which writes to the `.visually-hidden` live region,
which changes `document.body.outerHTML`, which the sweep counts as "something happened".

So the sweep's pass condition is *any* observable response, and a screen-reader announcement
qualifies — while the person filing the rejection is a sighted mouse operator who saw nothing
move. This is the same shape as the finding in comment `5f1bb2c1`, now demonstrated as a
property of the gate itself rather than of one control. The sweep is still worth keeping; it
should not be read as covering "does this respond to a *mouse*".

## A screenshot trap worth not falling into twice

`verify-webkit.swift` gained `--shot <out.png>`, so evidence offered to the board can come out of
the engine they review in rather than out of Chrome. Building it turned up a way for the harness
to lie:

An offscreen `WKWebView` rasterizes the stage as one large tile. Switch the theme *by script
after load* and the snapshot comes back with the panels repainted light and the canvas ground
still from the stale dark tile — a light-mode screenshot with a near-black canvas. It reads as a
broken light theme. It is not one: `#stage` measures `rgb(250, 248, 243)` and `.canvas-ground`
measures a `rgb(223, 217, 205)` dot grid at that moment, and the pre-fix build produces the
identical picture.

Two consequences, both now in the harness:

1. `--shot` takes a fragment on the path, so `…/prototype-standalone.html#wiring,light` selects
   screen and theme *at first paint* and there is no post-load repaint to miss.
2. The settle before the snapshot went to 1.6s, and says in a comment why.

The general form: `getComputedStyle` during a running transition returns the interpolated value,
and an offscreen snapshot returns whatever was last rasterized. Neither is a fact about the
design. Measure the DOM before believing a picture.

## Reproduce

```
node docs/mockups/build-standalone.mjs
swift docs/mockups/verify-webkit.swift docs/mockups/prototype-standalone.html \
  --eval docs/mockups/webkit-probe-provenance-drag.js
```

The counterfactual, which is what makes the above meaningful:

```
git show HEAD~1:docs/mockups/prototype-standalone.html > /tmp/prefix.html
swift docs/mockups/verify-webkit.swift /tmp/prefix.html \
  --eval docs/mockups/webkit-probe-provenance-drag.js
```
