# TNG-87 — press-drag-release from the capability library

Focused self-check for the fourth round of *"I cannot drag the agent from the
library."* Written before the artifact was attached, against the shipped bytes.

## Why there was a fourth round

Three fixes landed against this one sentence, and all three were verified by
calling `.click()` on a library row:

| commit | what it fixed | why the sentence survived |
|---|---|---|
| `25e9545` | WebKit selected text instead of dragging | correct, but only removed the *symptom* the screenshot showed |
| `cd5e162` | rows advertised a drag on screens where `dragstart` is refused | removed the drag *look*, leaving nothing that drags |
| `8f0c3b4` | a *click* on those screens routes to wiring and arms placement | a click is not a drag |

`click` is dispatched on the nearest common inclusive ancestor of the
`mousedown` and `mouseup` targets. Press a library row, release over the
canvas, and the click lands on the shell — the row's own listener never runs.
Measured in WKWebView against the attached candidate `8f0c3b4`
(SHA-256 `7dfd115b…`), at boot on `canvas`, the screen every rejection was
filed from:

```
[canvas] draggable="true": false | carried "r-oc" to the release point: 0 (want 1)
         | screen canvas -> canvas | click landed on DIV#stage (NOT the row)
```

`r-oc` is `opencode` — the row the rejection screenshot's selection anchored
on. Both mechanisms were dead at once: no native drag source, and the
synthesized click missing the row. That is why a suite green on click,
keyboard, and drag-on-`wiring` still shipped a no-op gesture.

A second defect surfaced while measuring: `go()` never re-rendered the
library, so `go('wiring')` then back to `canvas` left **12 of 12** rows still
carrying `draggable="true"`. `cd5e162`'s scoping held exactly until the
operator changed tabs once.

## The fix

- **`bindLibraryCarry()`** — the gesture gets its own implementation on
  ordinary pointer events, live on every screen the library appears on. Off
  `wiring`, releasing over the canvas routes to the freeform surface and drops
  the node at the release point: the destination `8f0c3b4` chose for the
  click, reached by the gesture the board actually performs. A labelled ghost
  follows the pointer and goes solid over a live drop, because *"nothing
  appears to happen"* is the complaint this path exists to answer.
- **Native HTML5 drag is unchanged** on `wiring` and takes precedence when it
  starts, so the existing `dragover`/`drop` path and its assertions stand.
- **Touch is excluded** — a vertical drag inside the library is how the list
  scrolls. The narrow layout keeps tap-to-place.
- **`draggable="true"` stays scoped** to where drop is wired; the grab cursor
  and drag-dots now render wherever a usable row does, because the carry works
  there. Look follows the carry; the attribute follows the drop wiring.
- **`go()` re-renders the library**, so the affordance describes the screen
  you are on rather than the one you came from.

## Verification

Reproducibility first: two consecutive `build-standalone.mjs` runs are
byte-identical — SHA-256 `e47054cb20a38edc0b41a6f7d151b81f4a2a80954c642ec6ccac23b2365f834c`,
608,839 bytes.

| check | result |
|---|---|
| `verify-prototype.mjs` (headless Chrome, real CDP input) | pass |
| `verify-webkit.swift` selection suite (TNG-127 invariant) | pass — 0/30 library labels selectable, 13 content opt-ins still selectable |
| `webkit-probe-library-gesture.js` (WKWebView) | PASS on `canvas` and `wiring` |
| `webkit-probe-library-routing.js` (the `8f0c3b4` click path) | still PASS — no regression |

Both new gates were run against a build with the fix removed, because a gate
that cannot fail is not a gate:

- **Chrome:** with `bindLibraryCarry()` disabled, the run fails at
  `Dragging a library row off the canvas screen did not route to the freeform
  surface: {"screen":"canvas",…}`.
- **WebKit:** the same probe against the attached `8f0c3b4` candidate reports
  `FAIL 2 check(s)` — the no-op gesture above, plus `stale draggable="true": 12`.

Node-count deltas are deliberately **not** used as evidence: routing to
`wiring` runs `initWiring()`, which reseeds the graph, so the count moves
whether or not anything was placed (measured +6 for a single drop). Both gates
assert the precise question instead — is there a node for *the row that was
dragged*, at *the point where it was released* (±2px).

## Independent re-verification, and the artifact the board was actually holding

Everything above was written by the run that made the fix. A later heartbeat
re-ran it against the *shipped* bytes, because the board's approval card was
still bound to `8f0c3b4` — the build this document measures as a no-op — and a
self-report has not held up on this issue before.

Reproducibility, checked in both directions:

| check | result |
|---|---|
| committed `prototype-standalone.html` vs. a fresh `build-standalone.mjs` | byte-identical, `git diff` clean |
| the uploaded approval attachment, downloaded back from the API, vs. `HEAD` | `cmp` clean — 608,839 bytes, SHA-256 `e47054cb…` |
| `bindLibraryCarry` in the uploaded bytes / in the `8f0c3b4` attachment | 4 / **0** |

The counterfactual was run against attachment `876facde` fetched from the
issue, not a local rebuild — 600,866 bytes, SHA-256 `7dfd115b…`, `cmp`-identical
to commit `8f0c3b4`, so it is the file a reviewer would have opened:

| `webkit-probe-library-gesture.js` | `8f0c3b4` (was in front of the board) | `6e87d28` |
|---|---|---|
| `canvas` | **FAIL** — no native drag source, no pointer carry, click lands on `DIV#stage` | ok — carried `r-oc` to the release point, `canvas → wiring` |
| `wiring` | native attribute only | ok — placed at the release point |
| after a tab round-trip | **FAIL** — 12/12 rows keep a stale `draggable="true"` | ok — 0 stale |
| verdict | **FAIL 2 check(s)** | **PASS every reviewed screen** |

`verify-prototype.mjs`, the `verify-webkit.swift` selection suite, and
`webkit-probe-library-routing.js` were all re-run clean on `HEAD` at the same
time.

### One gate was scoring itself green

`webkit-probe-library-routing.js` printed its three canvas-affordance counts
with a bare `(want …)` and then computed PASS/FAIL from the click routing
alone. `6e87d28` deliberately inverted two of those expectations — a usable row
now shows `grab` on every screen, because the carry works there — so the probe
printed `grab cursors on canvas: 12 (want 0)` immediately above the word
`PASS`. Nothing was broken, but the log read as a silent failure to anyone
auditing it, and the counts could not have caught a real regression. They are
assertions now, and the verdict counts them: green on `6e87d28`, `FAIL 2
check(s)` against the `8f0c3b4` candidate.

## Standing constraint

`dragstart` can only be raised by trusted input, so no script-driven harness
can prove the native drag end-to-end; the probe reports the attribute as the
precondition and leaves the drop path to `verify-prototype.mjs`. The pointer
carry has no such limit, which is a second reason to prefer it as the primary
path: the gesture the board performs is now the gesture the gates exercise.
