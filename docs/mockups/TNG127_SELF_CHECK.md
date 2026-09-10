# TNG-127 library drag starts a text selection in WebKit — focused self-check

Artifact: `docs/mockups/prototype-standalone.html`
(size / SHA-256 / commit recorded in the publishing comment on TNG-87, taken from the
committed bytes rather than from this run's working tree)

## Result

**PASS** — `node docs/mockups/verify-prototype.mjs`, full suite clean, with five new
assertions. Every one of them was confirmed to **fail** against the pre-fix stylesheet
before being accepted, so this is a checked regression rather than a decorative one.

## What this responds to

Board rejection on TNG-87, 2026-09-10 05:33Z, with a screenshot:

> I still cannot drag the agent from the library. It is highlighting the texts instead!

That is the sixth rejection on the library, and the third specifically about not being able
to drag. TNG-124 and TNG-125 both read the complaint as *discoverability* — rows too short,
no scroll affordance, grab handle only on hover — and fixed real problems each time. None of
them was the problem. The handle was visible; the gesture still did not work.

## Root cause

The prototype declared `user-select` **nowhere**. Zero occurrences across `prototype.css`,
`tokens.css`, `prototype.html`, and the shipped standalone.

Library rows are `draggable="true"` and contain three selectable text spans
(`.lib-row-name`, `.lib-row-sub`, `.lib-row-meta`). In WebKit, pressing on selectable text
inside a draggable element resolves the gesture as a **text selection**, and the drag never
arms. Chromium resolves the same ambiguity in favour of the drag.

The screenshot is a direct fingerprint of this: the selection anchors inside the `opencode`
row — highlighting the name and the `/opt/homebre…bin/opencode` path — and then runs forward
through DOM order across `LIBRARY`, `AGENTS`, the filter chips, and every canvas node label
(`Protocol Researcher`, `Spec Reviewer`, `Doc Author`, the model chips, the costs). That is a
drag-select sweeping the document, which is only possible if the press never became a drag.

## Why five consecutive self-checks passed on a broken gesture

This is the part worth keeping, because it is a hole in the method rather than in the CSS.

`verify-prototype.mjs` drives **headless Chrome only**. Two independent things follow:

1. Chromium prefers the drag over the selection, so the failure cannot be reproduced by
   gesture in this harness at all.
2. Chromium's **UA stylesheet already forces `user-select: none` on `[draggable="true"]` and
   its descendants**. Measured, not assumed — a minimal probe with no author CSS reports
   `none` on both the draggable element and its text children.

So the broken state was invisible twice over, and the byte-level greps that the Chief
Secretary used to check the previous two candidates were greps for the *handle*, which was
genuinely there. Everything anyone checked was true. The gesture was still broken.

Point 2 also disqualifies the obvious regression check: asserting that draggable rows compute
`user-select: none` would have passed against the broken build. That assertion was written,
measured, found vacuous, and replaced — see below.

## The fix

`#stage` — the app shell — now declares `user-select: none` / `-webkit-user-select: none`.

Scoped to the shell rather than to `.lib-row` deliberately. LoomWatch is a
direct-manipulation canvas, not a document, and the screenshot shows the same defect on the
canvas: the selection smeared across node labels, which means dragging a *node* had the same
ambiguity. Fixing only the library row would have left that.

A narrow set of surfaces opts back in with `user-select: text`, because selection is how they
get copied out:

| Surface | Why it stays selectable |
|---|---|
| `.rr-body`, `.rr-body code` | the model's answer — the main thing a user copies |
| `.ent-out` | sanitized command output (TNG-87 addendum §4 requires it be inspectable) |
| `.story-prompt .rt-body` | the user's own prompt |
| `.cite` | citation labels and locations |
| `.input`, `input`, `textarea`, `[contenteditable]` | **load-bearing** — in WebKit `user-select: none` inherits into form controls and leaves the field unable to select its own text |

The form-control row is the one that would have quietly broken the composer and the ⌘K
palette, so it is asserted, not just written.

## New assertions, and proof each one has teeth

Added to `verify-prototype.mjs` beside the existing TNG-125 grab-affordance block. Each was
run against the pre-fix stylesheet (`git show HEAD:docs/mockups/prototype.css`, rebuilt) to
confirm it fails, then against the fix to confirm it passes.

| Assertion | Pre-fix value | Post-fix |
|---|---|---|
| `#stage` computes `user-select: none` | `auto` — **fails** | `none` |
| an author rule on `#stage` declares it (CSSOM) | `null` — **fails** | `none` |
| `-webkit-user-select: none` survives into the shipped bytes | `false` — **fails** | `true` |
| library row text not selectable | `8` selectable — **fails** | `0` |
| canvas node labels not selectable | `5` selectable — **fails** | `0` |
| content opt-ins still selectable | `13` opt-ins, `0` locked | unchanged |

The CSSOM assertion exists specifically because a computed-style check cannot distinguish an
author rule from Chromium's UA rule. Reading the declaration off the stylesheet can, and that
declaration is the thing WebKit actually needs.

The bytes assertion exists because the `-webkit-` alias is collapsed by Chromium's CSSOM
(`cssText` normalises to the unprefixed form), so the prefix can only be checked in the
shipped text. It is belt-and-braces for older WebKit; current Safari takes the unprefixed
property.

## Honest limitation

**The gesture itself was not re-tested in WebKit.** No WebKit engine is available in this
environment: the Playwright cache holds Chromium only, and `safaridriver` needs an admin
`--enable` plus Safari's Allow Remote Automation, which is an interactive gate this run
should not force.

So what is proven here is the *invariant* that removes the ambiguity, verified to be absent
before and present after, plus the fact that `user-select: none` on the drag source is the
established remedy for this exact WebKit behaviour. What is **not** proven by automation is
the board successfully dragging a row in Safari. Given the history on this issue, that
distinction should be stated rather than smoothed over: the next confirmation should be
treated as confirmed by the board's own gesture, not by this document.

## Scope

Design-only. Two files changed under `docs/mockups/` (`prototype.css`, `verify-prototype.mjs`)
plus the rebuilt standalone. No production UI, backend, or schema changes. TNG-89
implementation remains gated.
