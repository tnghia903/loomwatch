#!/usr/bin/env node
// TNG-90 §9 — narrow/responsive conformance of the shipped workspace against
// docs/TNG89_INTERACTION.md §11.6 (TNG-115 keyboard and narrow composition).
//
// §11.6 is the last TNG-89A acceptance clause never checked against an implementation:
// "Show accepted light and black+gold dark themes, reduced motion, keyboard path, and
// responsive behavior." Themes are §1, reduced motion is §3, the keyboard/a11y path is §6.
// Below 768 px is this file.
//
// Asserts the CONTRACTS, not the current state: this exits non-zero while the gaps
// recorded in docs/mockups/TNG90_IMPLEMENTATION_CONFORMANCE.md §9 are open, and exits
// zero once they are closed. Exit 2 means the gate could not answer at all — an absent
// `ui/` input — so it can never read as a failure it did not observe.
//
//   node docs/mockups/verify-narrow-conformance.mjs
//
// Static source assertions, the same discipline as verify-a11y-conformance.mjs and
// verify-evidence-honesty.mjs: every rule is anchored to a line a reviewer can open, and
// heights are the values the stylesheets DECLARE at this width, not rendered measurements.
// A declared 28 px cannot render as 44 px, so a failure here is real; a pass means the
// contract is expressed, and a rendered check remains the stronger confirmation.

import { readFileSync } from 'node:fs'

// This gate measures the *implementation*, so its inputs live in `ui/` and are outside the
// `docs/` tree a Gate B pin extracts. Run against an extracted pin it cannot answer, and it
// says so (exit 2) rather than raising — an unreadable stack trace in a reviewer's terminal
// is indistinguishable from a real conformance failure.
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

const WORKSPACE = 'ui/src/components/Workspace.tsx'
const COLUMN = 'ui/src/components/run/RunColumn.tsx'
const PANEL = 'ui/src/components/run/ProvenancePanel.tsx'
const ACTIVITY = 'ui/src/components/run/ActivityPanel.tsx'
const APP_CSS = 'ui/src/styles/app.css'
const RUNTIME_CSS = 'ui/src/styles/runtime.css'

const workspace = read(WORKSPACE)
const column = read(COLUMN)
const panel = read(PANEL)
const activity = read(ACTIVITY)
const appCss = read(APP_CSS)
const runtimeCss = read(RUNTIME_CSS)

const results = []
const check = (id, spec, where, pass, detail) => results.push({ id, spec, where, pass, detail })

// A probe that has lost its anchor reads as a failure it did not actually observe.
function anchor(name, match) {
  if (!match) {
    console.error(`ANCHOR LOST: ${name} — the selector no longer matches. Re-anchor this probe before trusting any result.`)
    process.exit(2)
  }
  return match[0]
}

/** Every `@media (max-width: 767px)` body in a stylesheet, brace-matched. */
function narrowBlocks(css, label) {
  const blocks = []
  const at = /@media\s*\(max-width:\s*767px\)\s*\{/g
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
    console.error(`ANCHOR LOST: no @media (max-width: 767px) block in ${label} — re-anchor this probe.`)
    process.exit(2)
  }
  return blocks
}

const narrowCss = [...narrowBlocks(appCss, APP_CSS), ...narrowBlocks(runtimeCss, RUNTIME_CSS)].join('\n')

// A comment is not an implementation, and TNG-208 found three of this file's four contracts being
// met by prose or by an import: N1's coverage stage scored the `CoverageGlyph` import and the
// `coverage → filters → summaries` note above the section, N1's summaries stage scored the word
// "summaries" wherever it appeared, and N4's capture quality scored the comment that explains why
// capture quality is on the card. Every contract below reads comment-stripped source.
const decomment = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const columnCode = decomment(column)
const activityCode = decomment(activity)

// The branch that swaps the coordinate canvas for the reading column is the subject of
// every contract below; if it moves, nothing here is measuring what it claims to.
anchor('Workspace narrow branch', workspace.match(/\{runView && windowWidth < 768 \? \(/))
anchor('Workspace canvas branch', workspace.match(/\{\(!runView \|\| windowWidth >= 768\) && \(/))
const provenanceGuard = anchor('Workspace ProvenancePanel guard', workspace.match(/\{provenanceOpen && [^\n]*runView && \(/))
const actionsBlock = anchor('Workspace command actions', workspace.match(/const actions = useMemo<CommandAction\[\]>\(\(\) => \[[\s\S]*?\n {2}\], \[/))
anchor('Workspace toggleProvenance action', workspace.match(/toggleProvenance: \(\) => setProvenanceOpen\(/))
anchor('RunColumn causal list', column.match(/<div className="run-column" role="list"/))
anchor('ProvenancePanel coverage header', panel.match(/Complete capture|Partial capture/))

// --- N1 §11.6 the narrow column's four provenance stages ------------------------------------
// §11.6 fixes the source order of the narrow composition:
//   ... → Output / response → coverage → filters → summaries → selected evidence
//        → viewport-docked composer
// "Selected evidence" is met — RunColumn renders the activity entities and ActivityPanel is
// the overlay sheet. The three stages before it have no counterpart in the column at all.
// Each stage is asserted by what it *renders*, not by a word that appears near it. The coverage
// arm was `/coverageSummary\(|…|CoverageGlyph/`, which matched the glyph import on line 10 and the
// `const coverage = coverageSummary(projection)` binding — both of which survive deleting the
// stage itself, so the column could lose its coverage line entirely and score it as present
// (mutation 1 of `defeat-narrow-conformance.mjs`). Binding-relative, so a rename of the local
// cannot false-red it: whatever `coverageSummary()` is assigned to, its text has to reach JSX.
const coverageBinding = columnCode.match(/const (\w+) = coverageSummary\(/)
const columnHasCoverage = Boolean(coverageBinding) && new RegExp(`\\{${coverageBinding[1]}\\.text\\}`).test(columnCode)
// `filter` as a bare word matched `classes.filter(Boolean)` — a false pass, and the mirror of
// the stuck-at-fail this file is careful to avoid: it would have scored the filters stage as
// present against a column that had never had one. The contract is a filter *control* — a
// toggle the operator can press whose state the column reads back.
const columnHasFilters = /aria-pressed=/.test(columnCode) && /filter-chip|Filter the evidence|run-prov-filters/i.test(columnCode)
// `summar` matched "summaries" in three comments and in the `aria-label` of the list; `CATEGORIES
// .map` matched the *filters'* own iteration, one stage above. Delete the whole summaries list and
// all four alternatives still hit (mutation 2). What §4.1 asks for is per-category counts and
// coverage words, from the projector rather than the filtered view — so that is what is asserted.
const columnHasSummaries = /projection\.coverage\[category\.key\]/.test(columnCode) && /coverageWord\(level\)/.test(columnCode)
check(
  'N1', '§11.6 narrow source order', `${COLUMN} run-column`,
  columnHasCoverage && columnHasFilters && columnHasSummaries,
  `the narrow column must read "… Output / response → coverage → filters → summaries → selected evidence"; the column renders none of the first three (coverage: ${columnHasCoverage}, filters: ${columnHasFilters}, summaries: ${columnHasSummaries})`,
)

// --- N2 §11.6 failure 22 — narrow must not lose provenance selection or filtering -----------
// `ProvenancePanel` renders only while `provenanceOpen`, and the ONLY control that sets it
// true is the Response node's "Show provenance" toggle in StoryNodes — which lives inside
// the ReactFlow canvas the narrow branch replaces. So below 768 px the panel, its six
// grouped summaries (§4.1) and its filters (§4.4) cannot be reached by pointer, by the
// command palette, or by a shortcut.
// Bound to a control, not merely named. A bare `toggleProvenance` identifier passes for a
// column that destructures it from context and wires it to nothing — which is a column below
// 768 px with no route into provenance, the exact state this contract exists to reject.
const columnOpensProvenance = /on(?:Click|KeyDown|KeyUp|Press|Select)\w*=\{[\s\S]{0,60}?toggleProvenance/.test(columnCode)
// The palette arm had the defect the column arm was already fixed for, one level weaker: the bare
// word `provenance` anywhere in the actions block. A TODO promising the route — the single most
// likely thing to be sitting there at the moment the route is missing — scored as the route
// (mutation 5). A command action is a `run:` that does something, so that is the test.
const paletteOpensProvenance = /run: \(\) => [^\n]*(toggleProvenance|setProvenanceOpen)/.test(decomment(actionsBlock))
check(
  'N2', '§11.6 failure 22 — provenance/filtering survive', `${COLUMN} · ${WORKSPACE} actions · ${PANEL}`,
  columnOpensProvenance || paletteOpensProvenance,
  'below 768 px at least one reachable control must open the provenance panel — the narrow column carries no `toggleProvenance` route and the command palette has no provenance action, so §4.1 summaries and §4.4 filters are unreachable at this width',
)
// Guard the premise: this contract only means what it says while the panel stays gated on
// `provenanceOpen` and the canvas-only toggle is its one writer.
anchor('ProvenancePanel gated on provenanceOpen', provenanceGuard.match(/provenanceOpen/))

// --- N3 §11.6 failure 21 — 44 px targets --------------------------------------------------
// "The composition keeps authored text sizes and 44 px targets." / failure 21: "…makes a
// core action smaller than 44 px. Fail."
//
// The core actions at this width are the composer's Run / Save & run / Stop / Retry /
// New run (`.btn`), the run-history opener and the theme toggle (`.iconbtn`), and the mode
// chip. Their declared heights come from the base sheet unless a narrow rule lifts them.
const btnRule = anchor('.btn base height', appCss.match(/^\.btn \{\n\s*height: (\d+)px;/m))
const iconbtnRule = anchor('.iconbtn base height', appCss.match(/^\.iconbtn \{\n\s*width: \d+px; height: (\d+)px;/m))
const baseBtn = Number(/height: (\d+)px/.exec(btnRule)[1])
const baseIconbtn = Number(/height: (\d+)px/.exec(iconbtnRule)[1])

/**
 * Every narrow rule as `{ selectors, heights }`. CSS comments are stripped first, or their prose
 * is read as a selector.
 */
const narrowRules = [...decomment(narrowCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
  selectors: rule[1].split(',').map((selector) => selector.trim()).filter(Boolean),
  heights: [...rule[2].matchAll(/(?:min-)?height:\s*(\d+)px/g)].map((size) => Number(size[1])),
}))

/**
 * The height a selector resolves to among the narrow rules, or null when none pins one.
 *
 * Last declaration wins, not the smallest. This matters, and an earlier draft of this probe
 * got it wrong: `.mode-chip` was pinned to 32 px inside a narrow block, so a "take the
 * smallest" reading reports 32 px forever — including against a stylesheet someone has
 * correctly fixed by adding a later 44 px rule. That is a stuck-at-fail check, which is the
 * one defect a conformance gate may not have: it would tell an implementer their real fix
 * did not work.
 *
 * TNG-208: the *other* direction was worse. This matched the selector as a substring, so
 * `.pop-inline .btn { height: 44px; }` — a button inside a popover, and not one of the core
 * actions §11.6 names — was the last rule to match `.btn` and therefore the answer. Shrink every
 * composer button to the 28 px pointer size and the gate read 44 and passed (mutation 6 of
 * `defeat-narrow-conformance.mjs`): failure 21 shipped, scored clean, by the contract written to
 * catch exactly it. So the subject of the rule has to be the selector itself.
 */
function narrowPin(selector) {
  let resolved = null
  for (const rule of narrowRules) {
    if (!rule.selectors.includes(selector)) continue
    for (const height of rule.heights) resolved = height
  }
  return resolved
}

const resolved = {
  'composer .btn (Run / Save & run / Stop / Retry / New run)': narrowPin('.btn') ?? baseBtn,
  '.iconbtn (run history, theme toggle)': narrowPin('.iconbtn') ?? baseIconbtn,
  '.mode-chip': narrowPin('.mode-chip') ?? null,
}
const undersized = Object.entries(resolved).filter(([, px]) => px !== null && px < 44)

/**
 * The second reading, and the one a later rule cannot hide: no narrow rule anywhere may declare a
 * core action under the touch floor, whatever it is scoped to.
 *
 * `narrowPin` alone still cannot see `.lw-composer .mode-chip` — the chip's only narrow rule is
 * descendant-scoped, so the resolved reading is `null` and the chip drops out of `undersized`
 * entirely. This clause is monotone: a 32 px declaration stays visible however many 44 px rules
 * follow it, so between them the two readings cover both the rule that governs and the rule that
 * merely exists. Raising the offending declaration is the fix; adding a later one is not.
 */
const CORE_ACTION_CLASS = /\.(btn|iconbtn|mode-chip)\b/
const underFloor = narrowRules.flatMap((rule) => rule.selectors
  .filter((selector) => CORE_ACTION_CLASS.test(selector.split(/\s+/).pop() ?? ''))
  .flatMap((selector) => rule.heights.filter((height) => height < 44).map((height) => `${selector}: ${height}px`)))

check(
  'N3', '§11.6 failure 21 — 44 px targets', `${RUNTIME_CSS} · ${APP_CSS} @media (max-width: 767px)`,
  undersized.length === 0 && underFloor.length === 0,
  // The two readings answer different questions, so the failure says which one fired rather than
  // pooling them into a list that reads as one measurement.
  `every core action must resolve to at least 44 px below 768 px${undersized.length ? `; resolves to — ${undersized.map(([name, px]) => `${name}: ${px}px`).join(', ')}` : ''}${underFloor.length ? `; declared under the floor — ${underFloor.join(', ')}` : ''}`,
)

// --- N4 §11.6 — the cards carry what the lost geometry used to say --------------------------
// "Configured/provenance edge geometry and the library are omitted at this width. Their
// essential information is not: cards continue to state owner, event order/time, status,
// capture quality, and relationship."
//
// Owner, order/time, status and relationship are all on the face of the narrow card.
// Capture quality is not: it is interpolated into the aria-label only, and every visible
// rendering of the §5 honesty layer (the coverage header, the per-category level) lives in
// ProvenancePanel — which N2 shows cannot be opened at this width. So below 768 px the
// honesty layer has no visible expression at all, on the card or anywhere else.
//
// Spelling-independent: take the whole evidence card, strip the accessible name — the one
// place `capture` was already reaching — and ask whether anything is left. An earlier draft
// matched a literal `className="ae-cap`, which would have failed a correct fix that composed
// the class or named the element anything else.
//
// TNG-208: the strip-the-name-and-see-what-is-left reading was right, and it was reading the
// comment directly above the `.ae-cap` span — the note explaining *why* capture quality is on the
// card says the word three times. Delete the span and the card face still answered yes (mutation
// 9). Comments come out with the accessible name now. The overlay arm is a rendered interpolation
// for the same reason: "the inspector mentions capture somewhere in 400 lines" is not the claim.
const cardBlock = anchor('RunColumn evidence card', columnCode.match(/<button key=\{item\.id\}[\s\S]*?<\/button>/))
const cardFace = cardBlock.replace(/aria-label=\{`[^`]*`\}/g, '')
const captureOnFace = /capture/i.test(cardFace)
const captureInActivitySheet = /\{[^{}]*capture[^{}]*\}/i.test(activityCode)
check(
  'N4', '§11.6 cards state capture quality', `${COLUMN} ae-sub · ${ACTIVITY}`,
  captureOnFace || captureInActivitySheet,
  'the narrow evidence card must state capture quality on its face (it carries `item.capture` in the accessible name only), or the overlay inspector must; with ProvenancePanel unreachable at this width the §5 honesty layer is not visible anywhere below 768 px',
)

// --- report --------------------------------------------------------------------------------
const failed = results.filter((result) => !result.pass)
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  ${result.spec}  (${result.where})`)
  if (!result.pass) console.log(`        ${result.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} contracts met.`)
process.exit(failed.length === 0 ? 0 : 1)
