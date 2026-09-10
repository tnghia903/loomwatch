# TNG-125 residual reconciliation into the approval artifact — focused self-check

Artifact revision: `320bc70`
Artifact: `docs/mockups/prototype-standalone.html`
Exact size: **596,598 bytes**
SHA-256: `752eb5c6695bce87537de9e6f4209b146de163f230845e76139867f387746b16`

## Result

**PASS** — `node docs/mockups/verify-prototype.mjs`, full suite, clean, with new assertions
added for both landed states.

## What this responds to

Not a design complaint — a packaging-integrity one. The artifact attached for approval was
built at 13:05; `prototype.css` (13:06) and `prototype.js` (13:07) carried uncommitted edits
made after that build. So the bytes the board would open still showed drag dots only on
hover, which is materially the same thing they rejected on ("I cannot drag and drop
everything in the library sidebar"). The residual polish was the direct answer to that
rejection and it was sitting unbuilt in the working tree.

The instruction was to finish the residuals deliberately, not to commit the tree as-is. Each
of the three was judged on its merits.

### Working-tree note

Partway through this revision the concurrently-running TNG-87 session reverted
`prototype.css` and `prototype.js` in the shared workspace, discarding the uncommitted
residuals. They were re-derived from the diff captured at the start of this run, so nothing
was lost — but this is precisely why the artifact and the tree had diverged in the first
place, and it is the argument for the artifact being reproducible from a commit rather than
from whatever happened to be on disk.

## Item 1 — resting drag dots: **LANDED, reworked**

The residual proposed `.drag-dots` resting `0` -> `.35`, hover `.6` -> `.85`.

Landed the intent, changed the values. Measured in headless Chrome against the *composited*
row fill (walking the ancestor background stack, since `#library .lib-row` is a translucent
`color-mix` over the panel), in both themes:

| resting opacity | dark | light |
|---|---|---|
| `.35` (as proposed) | ~1.6:1 | — |
| `.7` | 2.99:1 | 2.94:1 |
| **`.75` (landed)** | **3.26:1** | **3.24:1** |
| `1` (hover) | 4.90:1 | 5.44:1 |

`.35` is not a visible affordance; shipping it would have answered the rejection on paper
only. `.75` clears the 3:1 non-text floor (WCAG 1.4.11) that a resting affordance has to
clear to count as one, and hover still steps to full value so the pointer gets its
confirmation. `.7` was tried first and rejected on measurement — it lands just under.

The dots are only emitted on usable rows (`libRowHTML`), so this never advertises a drag the
row would refuse. Asserted in the suite: every one of the 16 draggable rows carries a handle,
no unavailable row does, resting computed opacity `>= .75`, and every row carrying a handle
is actually `draggable="true"`.

## Item 2 — `.lib-row-arming`: **LANDED, reworked** (the class was not an orphan)

The issue asked whether the class was added ahead of the behaviour. It was not. The full
keyboard placement path has shipped since TNG-124 and is reachable:

- **arm** — `armPlaceFromLibrary()` from Enter/Space on a library row (`prototype.js`),
  guarded to the wiring screen, refusing unusable resources with a stated reason
- **move** — arrow keys in `wiringKey()`, 16 px steps, 64 px with Shift, clamped to canvas
- **place** — Enter/Space -> `commitPlace()`, focus moves to the new canvas node
- **cancel** — Escape -> clears `wiring.placing`, re-renders, announces, and returns focus to
  the row it was armed from
- `libRowHTML` echoes the class *and* appends "armed for placement" to the row's `aria-label`

So the behaviour was real and the style was the missing half. But the residual rule was
written unscoped:

```css
.lib-row.lib-row-arming { border-color: …; background: …; }   /* 0,2,0 */
```

and `#library .lib-row` (specificity `1,1,0`, and later in the file) sets both
`border-color` and `background`. Confirmed empirically rather than assumed — building with
the unscoped form and reading computed styles returned `border` identical to a resting row
and `bg` identical to a resting row. **Both declarations computed to nothing, in the only
place the class is ever emitted.** The residual arming state would have shipped invisible.

Landed as `#library .lib-row.lib-row-arming`, plus a `3px` inset accent rail — the same
`box-shadow: inset 3px 0 0` idiom already used by `.bar.halt` and `.rt-strip.alert`, and
DESIGN_LANGUAGE §12's status rail "at full value". The solid accent border deliberately
rhymes with `#stage.wiring-placing .wire-ghost`, which also goes solid for exactly this
moment. The rail matters for a second reason: `:hover` in `#library` only moves the border to
`accent-dim`, so without a channel hover does not use, "armed" and "hovered" would read the
same. Position rather than hue also means the state survives the greyscale proof.

## Item 3 — group-header glyphs: **DROPPED**

The residual gave each `RES_GROUPS` entry a `glyph` and rendered `entGlyph(g.glyph, 12)` in
each group header. Dropped on a semantic collision, not on taste:

`ENT_GLYPH.agent` is a **circle**. Inside `#library`, `.monogram` / `.monogram.res` already
assign **square = agent, circular = capability** — with an explicit comment citing
DESIGN_LANGUAGE §12 that *shape, not colour, carries the distinction so it survives the
greyscale proof*. Rendering a circle as the label for the **Agents** group directly
contradicts the rule the same panel establishes one element away.

The redundancy argument compounds it: for Skills, Tools and Knowledge the header glyph only
restates the glyph every row underneath already shows in its monogram; for Agents — the one
group where rows show a harness monogram instead — it would introduce a glyph appearing
nowhere else in the panel, and the wrong one. The four group labels already name the kind
unambiguously, and `.lib-chev` already leads with a chevron.

Fixing it properly would mean a new square-framed agent glyph outside `ENT_GLYPH`, which is
not residual polish. `prototype.js` is therefore byte-identical to `ba8d224`.

## Item 4 — `docs/WEBSOCKET_SCHEMA.md`: **NOT MINE, LEFT ALONE**

The one-line uncommitted edit ("macOS app" -> "web UI") is not from this line of work. TNG-124
and TNG-125 are confined to `docs/mockups/`; this file is a Phase-03 schema document marked
**frozen**, and the edit aligns it with ADR 0003 (web UI served by the daemon) — Phase-04
architecture housekeeping, not design. It also arrived alongside untracked
`docs/decisions/0006`, `0007` and `teams/`, which belong to the concurrent TNG-87 session
holding this workspace. Left uncommitted and untouched, as instructed.

## Reproducibility fix (in scope via requirement 5)

Requirement 5 asked that the standalone be byte-reproducible from the commit. It was not, and
could not be: the builder stamped `new Date()` into the header, so two builds of *identical*
sources differed by exactly one line. An approval baseline that cannot be checked against a
rebuild is the same class of problem this issue was opened about.

`build-standalone.mjs` now stamps a SHA-256 digest of its five inputs (`prototype.html`,
`tokens.css`, `prototype.css`, `prototype.js`, the inlined font CSS) instead of the moment it
ran — which is the question an approval baseline actually has to answer; the commit already
records the when. Verified byte-identical across three consecutive builds.

## New automated coverage

TNG-124's self-check flagged that no assertions were added for its work. This revision closes
part of that gap for the states it touches:

- resting grab handle: presence on all 16 usable rows, absence on unavailable rows, computed
  resting opacity `>= .75`, and `draggable="true"` agreement
- armed source row: the class lands on the *correct* row, its **computed** border and
  background differ from a resting sibling (this is the assertion that would have caught the
  unscoped rule), the status rail is present, and the `aria-label` announces the state
- Escape cancels: `wiring.placing` cleared, no row left marked, **focus returned to the row it
  was armed from**, and no node dropped — a leg of the path the suite never exercised

The suite's success line now names TNG-124 and TNG-125.

## Not verified here

- Only the resting/hover drag-dot contrast was measured. The arming rail and border reuse
  `--color-accent`, already verified in `DESIGN_LANGUAGE.md §16`; no new token was introduced.
- The armed state was verified by computed style and by assertion, not by screenshot diff.
- The native-drag reachability probe from TNG-124 is still a one-off and still not in the
  permanent suite; that recommendation stands.

Design-only. No production UI, backend, or schema changes; no new node type, edge type, or
endpoint.
