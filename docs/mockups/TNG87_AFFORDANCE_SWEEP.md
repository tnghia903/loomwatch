# Affordance sweep of the reviewed screen — findings

Run against `prototype-standalone.html` at commit `6e87d28`
(SHA-256 `e47054cb20a38edc0b41a6f7d151b81f4a2a80954c642ec6ccac23b2365f834c`), the exact
bytes attached to the pending board card.

```
swift docs/mockups/verify-webkit.swift \
  docs/mockups/prototype-standalone.html \
  --eval docs/mockups/webkit-probe-canvas-affordances.js
```

## Why this was run

Four rejections on TNG-87 have followed one shape: the board presses a control on the
default `canvas` screen, nothing happens, and the round is spent fixing that one control.
Each fix was correct and each time the next round found the *next* silent control on the
same screen. The reviewer never leaves `canvas` and never uses the protobar tabs, so every
affordance rendered there is in scope for their next press.

So rather than verify the named fix again, this sweeps the boot screen and asks each
apparently-pressable element the reviewer's own question: *I pressed it — did anything
happen?* "Something happened" is deliberately broad (any change to the serialized document,
the screen, the node model, focus, or scroll), because the goal is to clear controls, not
to assert a particular behaviour.

## Result

**27 of 34 reachable affordances answer a press. Five do not.** The live majority is what
makes the five findings rather than detector artifacts — a probe blind to this page's
responses would have flagged all 34.

Two further silent controls are reported but not counted, because they are silent by
nature rather than by defect: `#libSearch` (a dispatched press cannot move focus, and focus
is all a real click there does — this probe cannot judge it) and the `Any state` filter
(already the selected state, so re-selecting it correctly renders an identical DOM).

## Findings

### 1. The view controls do nothing — `Zoom out`, `Zoom in`, `Fit view`

`prototype.html:424-426`. Three `<button class="iconbtn">` with a `title`, an icon, and no
handler of any kind — no `onclick`, no listener, no delegation. The fourth button in the
same cluster, `#themeBtn`, carries `onclick="toggleTheme()"`, so three of four visually
identical buttons in one 168 px pill are dead.

This is a spec gap, not an unimplemented nicety. CANVAS_SPEC §7.1 lists the view controls
as a first-class input for both operations:

| zoom | `⌘`/`Ctrl` + scroll · pinch · `⌘+` / `⌘−` · **view controls** |
| fit to content | `F`, or **`⤢` in the view controls**; 64 px padding, capped at zoom 1.0 |

Reviewer risk is high: the cluster sits bottom-right on the screen every rejection has come
from, it is labelled with the shortcuts it claims to mirror, and "zoom" is an obvious thing
to try on something captioned *Pipeline · 3 steps*.

Note that the prototype has a working convention for a control that is deliberately not
live yet — `#modepill .runslot` uses `cursor: not-allowed` and the title *"Running a team
arrives in a later phase."* These buttons do not use it; they present as fully live.

### 2. The mode pill's popover is missing entirely

`prototype.html:388-399`, `prototype.css:745-751`. `#modepill` computes `cursor: pointer`
across its whole surface and contains no interactive child at all — only `<span>`s for the
glyph, the label, the anomaly badge, and the reserved run slot.

The hand cursor is not the mistake here; the spec says that surface should be clickable.
CANVAS_SPEC §8.1 calls the pill *"the one piece of chrome that explains the whole
document"* and specifies:

> Clicking it opens an `e2` popover — the only place execution semantics are explained, and
> it is disclosed, not resident

with defined content for both modes (team-bus availability and a `guards` summary with an
edit affordance for `guards` and `budget`; or the resolved pipeline order and any join
node). None of that popover exists in the prototype. The cursor advertises it correctly and
then nothing answers.

The red anomaly badge (`⚠ 1`) compounds it: a count of problems, styled in the alert
colour, under a hand cursor, with no way to see what the one anomaly is.

### 3. The document chip's padding is a dead hand-cursor strip — minor

`prototype.css:354-360`. `cursor: pointer` is set on `#chip` itself, but the live controls
are its children (`#chipOpen`, `flex: 1`, and `#chipAction`). The chip's left/right padding
therefore shows a hand and does nothing. The dead region is only a few pixels wide, so this
is cosmetic next to the two above — the fix is to move the cursor declaration onto the
children, or make the container's whole box delegate to `#chipOpen`.

## What was not changed

Nothing under `docs/mockups/` that the standalone is built from. A board card is pending on
`6e87d28`, and changing the artifact mid-review is how earlier rounds lost their approval
target. This sweep adds a probe and this document only; `prototype-standalone.html` still
hashes to `e47054cb…`, byte-identical to the attachment under review.
