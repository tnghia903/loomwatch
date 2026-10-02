#!/usr/bin/env node
// CANVAS_SPEC §13 (height) — short-viewport conformance of the shipped workspace.
//
// §13's last rule: "Height below 600 px: the mode pill and view controls merge into a single
// bottom-right cluster." It is the one §12/§13 contract the TNG-89 rebuild dropped — the rule
// targeted `.react-flow__controls`, `.canvas-mode-control` and `--canvas-bottom-offset`, all
// three of which the rebuild deleted, so it died with its selectors (TNG-201).
//
// This gate exists because of how it came back. The first re-expression closed the gap by
// setting `display: none` on `.comp-mid` and `.comp-act` — the prompt textarea and the run
// action — and on `.mode-pop`, the popover the surviving `.mode-chip` still advertises via
// `aria-haspopup`. That trades a missing rule for a product with no way to prompt and a dead
// affordance (TNG-203). A grep for "does the rule exist" scores that implementation as fixed.
// So every contract below asserts what must SURVIVE the rule, not merely that it is present.
//
//   node docs/mockups/verify-short-viewport.mjs
//
// Static source assertions, the same discipline as verify-narrow-conformance.mjs: every rule
// is anchored to a line a reviewer can open, and declarations are read from the stylesheet
// rather than measured, because a declared `display: none` cannot render as visible.
// Exit 2 means the gate could not answer at all — an absent `ui/` input, or a lost anchor —
// so it can never read as a failure it did not observe.

import { readFileSync } from 'node:fs'

// This gate measures the *implementation*, so its inputs live in `ui/` and are outside the
// `docs/` tree a Gate B pin extracts. Run against an extracted pin it cannot answer, and it
// says so (exit 2) rather than raising.
const read = (path) => {
  try {
    return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    console.error(`CANNOT RUN — the shipped input is missing:
    ${path}
    (production source, NOT part of a pinned \`docs/\` artifact)

This gate measures the shipped implementation against the approved design, so it needs
the \`ui/\` tree and only answers from a full repo checkout. It is not a statement about
the pinned artifact, and this is not a conformance failure.`)
    process.exit(2)
  }
}

const COMPOSER = 'ui/src/components/composer/Composer.tsx'
const RUNTIME_CSS = 'ui/src/styles/runtime.css'

const composer = read(COMPOSER)
const runtimeCss = read(RUNTIME_CSS)

const results = []
const check = (id, spec, where, pass, detail) => results.push({ id, spec, where, pass, detail })

// With no rule at all, H2-H5 are vacuously unmet — but their detail text describes what a
// *wrong* rule does, which would report one missing rule as five separate defects with four
// wrong mechanisms. Say the true cause and point at H1 instead.
const ABSENT = 'no `@media (max-height: 599px)` block exists, so this contract is unmet for want of the rule entirely — fix H1 first; this is not a separate defect'
const because = (detail) => (shortCss === null ? ABSENT : detail)

function anchor(name, match) {
  if (!match) {
    console.error(`ANCHOR LOST: ${name} — the selector no longer matches. Re-anchor this probe before trusting any result.`)
    process.exit(2)
  }
  return match[0]
}

/** Strip comments so a probe cannot be satisfied by prose describing the contract. */
const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Every `@media (max-height: 599px)` body, brace-matched and comment-stripped. */
function shortBlocks(css, label) {
  const blocks = []
  const at = /@media\s*\(max-height:\s*599px\)\s*\{/g
  let hit
  while ((hit = at.exec(css)) !== null) {
    let depth = 1
    let i = at.lastIndex
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') depth -= 1
      i += 1
    }
    blocks.push(css.slice(at.lastIndex, i - 1))
  }
  if (blocks.length === 0) {
    console.error(`NO SHORT-VIEWPORT RULE in ${label}.

CANVAS_SPEC §13 requires a height < 600 px behaviour and the stylesheet declares none.
This is the TNG-201 gap, not a lost anchor — the contract is unimplemented.`)
    // A missing rule is a real, observed failure of H1, so report it as one rather than
    // exiting 2 (which would say "could not answer").
    return null
  }
  return decomment(blocks.join('\n'))
}

const shortCss = shortBlocks(runtimeCss, RUNTIME_CSS)

// The premise of H2-H5: these are the elements §13's rule acts on. If the composer stops
// rendering them, every contract below is measuring a shape that no longer exists.
anchor('Composer prompt textarea inside .comp-mid', composer.match(/className="comp-mid"[\s\S]{0,400}?<textarea/))
// The opening tag is what carries the popup ARIA H4 reads; the chip's children do not. The chip
// became a non-interactive <span> when the mode popover was retired (CANVAS_SPEC §8.1); either
// tag is anchored so a chip that grows a popup again is still read by H4.
const modeChip = anchor('Composer mode chip', composer.match(/<(?:button|span)[^>]*className=\{`mode-chip[^>]*>/))
anchor('Composer action group', composer.match(/className="comp-act"/))

/** Does `selector` get `display: none` inside the short-viewport block? */
function hiddenInShort(selectorPattern) {
  if (!shortCss) return false
  // Match a rule whose selector list contains the pattern and whose body sets display:none.
  const rule = new RegExp(`(^|\\})([^{}]*${selectorPattern}[^{}]*)\\{([^{}]*)\\}`, 'g')
  let hit
  while ((hit = rule.exec(shortCss)) !== null) {
    if (/display:\s*none/.test(hit[3])) return true
  }
  return false
}

// --- H1 the rule exists at all ---------------------------------------------------------------
check(
  'H1', '§13 height < 600 px rule is implemented', `${RUNTIME_CSS} @media (max-height: 599px)`,
  shortCss !== null,
  'CANVAS_SPEC §13 requires a height < 600 px behaviour; no `@media (max-height: 599px)` block exists, so the rule is unimplemented (TNG-201)',
)

// --- H2 the prompt input survives ------------------------------------------------------------
// §13 clusters chrome. It never authorized removing the composer, and TNG89 §11.6 failure 21
// ("clips the composer/response") treats losing it as a Fail in the width direction; height is
// the same contract. `.comp-mid` holds the textarea, so hiding it removes prompt entry.
check(
  'H2', '§13 keeps the prompt input', `${RUNTIME_CSS} · ${COMPOSER} comp-mid`,
  shortCss !== null && !hiddenInShort('\\.comp-mid') && !hiddenInShort('textarea'),
  because('below 600 px height the short-viewport rule sets `display: none` on the composer\'s `.comp-mid` (or its textarea) — that is the prompt input, so the operator cannot type a goal at this size'),
)

// --- H3 the run action survives --------------------------------------------------------------
// `.comp-act` holds the primary Save & run / Run button and the run-history control. TNG89
// §11.6 failure 22 — "Narrow mode loses submission … Fail."
check(
  'H3', '§13 keeps the run action', `${RUNTIME_CSS} · ${COMPOSER} comp-act`,
  shortCss !== null && !hiddenInShort('\\.comp-act'),
  because('below 600 px height the short-viewport rule sets `display: none` on `.comp-act` — that is the primary run action and the history control, so a run cannot be submitted at this size'),
)

// --- H4 no dead affordance -------------------------------------------------------------------
// The mode chip renders `aria-haspopup="dialog"` + `aria-expanded`. Hiding `.mode-pop` while
// the chip still renders leaves a control advertising a dialog that never paints — the
// TNG-131 defect class, and worse here because the ARIA keeps claiming the state.
const chipAdvertisesPopup = /aria-haspopup=/.test(modeChip)
check(
  'H4', '§13 leaves no control advertising a hidden popover', `${RUNTIME_CSS} · ${COMPOSER} mode-chip`,
  shortCss !== null && !(chipAdvertisesPopup && hiddenInShort('\\.mode-pop')),
  because('the short-viewport rule hides `.mode-pop` while `.mode-chip` still renders `aria-haspopup="dialog"` — the chip stays pressable and announces an expandable dialog that is `display: none`, which is a dead affordance rather than a responsive rule'),
)

// --- H5 the merge actually happens -----------------------------------------------------------
// §13's rule is a *merge*: the pill and the view controls become one bottom-right cluster.
// The rebuild's 768-1179 rule stacks `.lw-viewctl` a second 68 px band above the composer,
// which is exactly the vertical cost §13 exists to reclaim — so the short-viewport block has
// to bring it back down. Asserted as a `bottom` declaration on `.lw-viewctl`, not a bare
// mention: the selector appearing in a comment or an unrelated property is not the merge.
const mergesViewControls = shortCss !== null
  && /[^{}]*\.lw-viewctl[^{}]*\{[^{}]*bottom:[^{}]*\}/.test(shortCss)
check(
  'H5', '§13 merges the view controls into the composer band', `${RUNTIME_CSS} .lw-viewctl`,
  mergesViewControls,
  because('the short-viewport rule never re-positions `.lw-viewctl`, so the view controls keep the second stacked band the 768-1179 rule gives them — §13 asks for one merged bottom-right cluster, and reclaiming that band is the point of the rule'),
)

// --- report ----------------------------------------------------------------------------------
let failed = 0
for (const r of results) {
  if (r.pass) {
    console.log(`PASS  ${r.id}  ${r.spec}  (${r.where})`)
  } else {
    failed += 1
    console.log(`FAIL  ${r.id}  ${r.spec}  (${r.where})`)
    console.log(`      ${r.detail}`)
  }
}
console.log()
if (failed === 0) {
  console.log(`${results.length}/${results.length} contracts met.`)
  process.exit(0)
}
console.log(`${results.length - failed}/${results.length} contracts met — ${failed} open.`)
process.exit(1)
