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
// zero once they are closed.
//
//   node docs/mockups/verify-narrow-conformance.mjs
//
// Static source assertions, the same discipline as verify-a11y-conformance.mjs and
// verify-evidence-honesty.mjs: every rule is anchored to a line a reviewer can open, and
// heights are the values the stylesheets DECLARE at this width, not rendered measurements.
// A declared 28 px cannot render as 44 px, so a failure here is real; a pass means the
// contract is expressed, and a rendered check remains the stronger confirmation.

import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

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
const columnHasCoverage = /coverageSummary\(|Complete capture|Partial capture|CoverageGlyph/.test(column)
// `filter` as a bare word matched `classes.filter(Boolean)` — a false pass, and the mirror of
// the stuck-at-fail this file is careful to avoid: it would have scored the filters stage as
// present against a column that had never had one. The contract is a filter *control* — a
// toggle the operator can press whose state the column reads back.
const columnHasFilters = /aria-pressed=/.test(column) && /filter-chip|Filter the evidence|run-prov-filters/i.test(column)
const columnHasSummaries = /CATEGORIES\.map|summar|ProvenancePanel|zone-head/i.test(column)
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
const columnOpensProvenance = /on(?:Click|KeyDown|KeyUp|Press|Select)\w*=\{[\s\S]{0,60}?toggleProvenance/.test(column)
const paletteOpensProvenance = /provenance/i.test(actionsBlock)
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
 * The height a selector resolves to among the narrow rules, or null when none pins one.
 *
 * Last declaration wins, not the smallest. This matters, and an earlier draft of this probe
 * got it wrong: `.mode-chip` is already pinned to 32 px inside a narrow block, so a "take the
 * smallest" reading reports 32 px forever — including against a stylesheet someone has
 * correctly fixed by adding a later 44 px rule. That is a stuck-at-fail check, which is the
 * one defect a conformance gate may not have: it would tell an implementer their real fix
 * did not work.
 *
 * `narrowCss` is assembled app.css-then-runtime.css, which is the order `ui/src/index.css`
 * imports them, so source order here is cascade order. The assumption this cannot see is
 * specificity: it reads the last *matching* declaration, not the winning one. A fix that
 * loses the cascade to a more specific 32 px rule would be scored as a pass — so a rendered
 * measurement stays the stronger confirmation, as the header says.
 */
function narrowPin(selectorSource) {
  const rule = new RegExp(`${selectorSource}[^{}]*\\{([^}]*)\\}`, 'g')
  let resolved = null
  let hit
  while ((hit = rule.exec(narrowCss)) !== null) {
    for (const size of hit[1].matchAll(/(?:min-)?height:\s*(\d+)px/g)) {
      resolved = Number(size[1])
    }
  }
  return resolved
}

const narrowBtn = narrowPin('\\.btn')
const narrowIconbtn = narrowPin('\\.iconbtn')
const narrowModeChip = narrowPin('\\.mode-chip')
const resolved = {
  'composer .btn (Run / Save & run / Stop / Retry / New run)': narrowBtn ?? baseBtn,
  '.iconbtn (run history, theme toggle)': narrowIconbtn ?? baseIconbtn,
  '.mode-chip': narrowModeChip ?? null,
}
const undersized = Object.entries(resolved).filter(([, px]) => px !== null && px < 44)
check(
  'N3', '§11.6 failure 21 — 44 px targets', `${RUNTIME_CSS} · ${APP_CSS} @media (max-width: 767px)`,
  undersized.length === 0,
  `every core action must resolve to at least 44 px below 768 px; declared instead — ${undersized.map(([name, px]) => `${name}: ${px}px`).join(', ')}`,
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
const cardBlock = anchor('RunColumn evidence card', column.match(/<button key=\{item\.id\}[\s\S]*?<\/button>/))
const cardFace = cardBlock.replace(/aria-label=\{`[^`]*`\}/g, '')
const captureOnFace = /capture/i.test(cardFace)
const captureInActivitySheet = /capture/i.test(activity)
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
