# TNG-127 library drag starts a text selection in WebKit — focused self-check

Artifact revision: `76cd2a4` (fix landed in `25e9545`, proof added in `76cd2a4`)
Artifact: `docs/mockups/prototype-standalone.html`
Exact size: **598,128 bytes**
SHA-256: `ea9a305617c94c84be9f9ae377f3f5416f5ddad8f7e96148defeec5e59e6e194`

Verified against the commit, not against the working tree: `git show HEAD:docs/mockups/prototype-standalone.html`
hashes to the value above, matches the file on disk byte-for-byte, and `node build-standalone.mjs`
reproduces that same hash from source. The committed bytes contain the fix (`-webkit-user-select: none`
present in the shipped standalone, not merely in `prototype.css`).

## Result

**PASS**, on two engines.

- `node docs/mockups/verify-prototype.mjs` — full suite clean (headless Chrome).
- `/tmp/verify-webkit docs/mockups/prototype-standalone.html` — 6/6 (real WKWebView).

## What this responds to

Third rejection about dragging, and the first to name the mechanism: *"I still cannot drag the
agent from the library. It is highlighting the texts instead."*

The prototype declared `user-select` nowhere. Library rows are `draggable="true"` and carry
selectable text spans; in WebKit, pressing on selectable text inside a draggable element
resolves the gesture as a text selection and the drag never arms. TNG-124 and TNG-125 both
read the complaint as *discoverability* and fixed real problems — neither was this one. A
visible grab handle on a row that cannot be dragged is still a rejection.

## Why five self-checks certified a gesture that did not work

`verify-prototype.mjs` drives headless Chrome only, and **Chromium's UA stylesheet already
forces `user-select: none` on `[draggable="true"]` and its descendants**. So the library rows
reported `none` under test even when no author rule existed anywhere in the codebase. The
harness was reading Chromium's UA sheet and scoring it as our fix. WebKit has no such rule,
which is the entire bug. Every green check was true and irrelevant.

This is the finding worth keeping: the gate was not merely incomplete, it was *structurally
incapable* of observing the defect, and it returned green with full confidence five times.

## What I added on top of the fix

The CSS fix (`#stage { user-select: none }` plus a narrow content opt-in) was landed by the
concurrently-running TNG-87 session in `25e9545` while this run was in flight. It was correct,
and I verified rather than redid it. But it had been checked the same Chrome-only way as the
five self-checks that missed the bug — so the fix was still resting on an unproven claim about
an engine nothing in this repo had ever run.

### 1. A WebKit proof — `docs/mockups/verify-webkit.swift`

Loads the shipped standalone into a real `WKWebView` (the engine Safari uses) and probes twice.
Uses only the macOS command-line tools — no Safari automation, no admin enablement, no package
install. Playwright has no WebKit build here and `safaridriver` remote automation is disabled
and needs admin, so both of those paths were dead ends; a `WKWebView` host binary was not.

| check | as shipped | rule defeated |
|---|---|---|
| `#stage` computed `user-select` | `none` | `text` |
| library row labels selectable | **0 / 30** | **30 / 30** |
| canvas node labels selectable | **0 / 6** | — |
| content opt-ins wrongly locked | **0 / 13** | — |

Pass B is the point. It is the counterfactual headless Chrome *physically cannot produce*:
defeat the author rule and the library labels go selectable again, which proves WebKit has no
UA fallback and the rule is load-bearing rather than decorative. Delete the rule later and
pass A fails; lean on a UA sheet only Chromium has and pass B fails.

The fourth row is the inverse guarantee: locking the shell must not cost the user the ability
to copy the model's answer, command output, their own prompt, or to edit a field. All 13
opt-ins stay selectable in WebKit.

### 2. Repaired a check that could never have failed

The Chrome harness asserted over `'#nodes .w-top, #nodes .n-title'`. `.n-title` exists nowhere
in the codebase and `.w-top` only renders in the wiring view — so that `querySelectorAll`
matched **zero elements** in the probed view and the assertion was vacuously true, against
exactly the surface the rejection screenshot showed the selection smearing across. Caught it
because the WebKit harness reported `nodeLabelTotal: 0`.

Now targets `.node-name, .node-top, .w-name, .w-top` (6 real elements), and both the library
and node-label checks assert their totals non-zero, so a rename cannot quietly turn them back
into no-ops. Same vacuity guard is built into the WebKit harness.

## What is *not* proven

Stated plainly, because overclaiming is how this ticket happened.

- The harness proves the **computed-style invariant** in WebKit and proves the rule is
  load-bearing. It does **not** synthesize a real mouse-press-and-drag in WebKit and confirm a
  drop completes. The invariant is the documented cause of the failure, but it is one step
  removed from the gesture itself.
- `WKWebView` is the same engine as Safari, not the same browser. Safari's own chrome,
  extensions, and UA differences are out of scope here.
- Residual risk is therefore: if Safari's drag arming depends on something beyond selection
  eligibility, this would still pass. Confirming the actual gesture needs a human on Safari —
  which is the board's review.

## Working-tree note

This ran concurrently with the TNG-87 session in a shared workspace. That session committed
`prototype.css` and the standalone at 05:42Z mid-run; the checks here were re-run against the
committed result and my changes were confirmed additive (`git diff` touched only
`verify-prototype.mjs`, `README.md`, and the new `verify-webkit.swift`). Nothing was clobbered
in either direction.
