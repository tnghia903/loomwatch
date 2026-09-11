#!/usr/bin/env node
// TNG-90 §7 — evidence-quality conformance of the shipped workspace against
// docs/TNG89_INTERACTION.md §5 (capture states, coverage, the word "complete")
// and docs/RUN_PROVENANCE_CONTRACT.md §8.1 / §12.
//
// Asserts the CONTRACTS, not the current state: exits non-zero while the gaps
// recorded in docs/mockups/TNG90_IMPLEMENTATION_CONFORMANCE.md §7 are open, zero
// once they are closed, and 2 if the gate cannot answer at all — a drifted selector
// or an absent `ui/` input — so neither can ever read as a failure it did not observe.
//
//   node docs/mockups/verify-evidence-honesty.mjs

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

const PANEL = 'ui/src/components/run/ProvenancePanel.tsx'
// TNG-173: the level lookup and the §5.2 coverage sentence moved out of the panel into a
// module the narrow RunColumn shares, so the two surfaces cannot state different coverage
// for the same run. B3's subject moved with it.
const COVERAGE = 'ui/src/components/run/coverage.ts'
const NODES = 'ui/src/components/run/StoryNodes.tsx'
const COLUMN = 'ui/src/components/run/RunColumn.tsx'
const EVENTS = 'ui/src/lib/watch/events.ts'

const panel = read(PANEL)
const coverageModule = read(COVERAGE)
const nodes = read(NODES)
const column = read(COLUMN)
const events = read(EVENTS)

const results = []
const check = (id, spec, where, pass, detail) => results.push({ id, spec, where, pass, detail })

function anchor(name, match) {
  if (!match) {
    console.error(`ANCHOR LOST: ${name} — the selector no longer matches. Re-anchor this probe before trusting any result.`)
    process.exit(2)
  }
  return match[0]
}

// --- §5.1 Capture states ---------------------------------------------------------------------
// The contract (§8.1) makes `capture` a property of an entity: recorded / derived /
// redacted / unavailable. Interaction §5.1 then requires all four on three channels
// (border, glyph, word), "and the word is never omitted to save space".
//
// B1 — TNG-170 closed it; the check below is the re-anchored, stronger contract.
// `capture` is modelled on the projection: the `Capture` type admits exactly CONTRACT
// §8.1's four values, `interface Evidence` (and `ProjectedAgent`, whose agent rows on the
// panel speak the same word) carries it, and the projector sets it from its one justified
// invariant — every projected entity is built solely from accepted `RunEvent`s, which §8.1
// defines as `recorded`. No code path emits `derived`, `redacted` or `unavailable` (the
// last is a category-level fact, §5.1) and none is fabricated. The probe asserts both
// halves — the field is on the entity, and the type names the four values — so a later
// code path cannot start emitting a state the type has silently stopped admitting, and a
// surface cannot regress to asserting the word locally: B2 now pins that too.
const evidenceType = anchor('Evidence interface', events.match(/export interface Evidence \{[\s\S]*?\n\}/))
const captureType = anchor('Capture type (CONTRACT §8.1 values)', events.match(/export type Capture = '[^\n]*/))
check(
  'B1', '§5.1 / CONTRACT §8.1 capture is modelled', `${EVENTS} type Capture + interface Evidence`,
  /\n\s*capture\b/.test(evidenceType) && /'recorded'/.test(captureType) && /'derived'/.test(captureType) && /'redacted'/.test(captureType) && /'unavailable'/.test(captureType),
  'Evidence must carry a `capture` field and `Capture` must admit exactly CONTRACT §8.1\'s four values — the word is then sourced from the projection, and §8.1\'s states stay representable',
)

// The word, on the three surfaces that render an entity control — read from the entity
// rather than asserted locally. TNG-170 re-anchored B2 to this stronger contract: the
// original shape (a capture-word literal at each surface) was exactly what let B1's
// hardcoded constant go unnoticed, so the probe now pins each surface to interpolating
// the entity's own `capture` field. The word's single source is the projector, and the
// first genuinely `derived` or `redacted` entity flows through with no surface edit.
// Scoped to the controls themselves — the panel's zone-head says "Not captured" about a
// *category*, which is §5.2's coverage word and a different axis from an entity's capture
// state.
const entityRow = anchor('ProvenancePanel entity row', panel.match(/<button type="button" className="pop-row"[\s\S]*?<\/button>/))
const evidenceCard = anchor('EvidenceNodeCard aria-label', nodes.match(/aria-label=\{`Inspect [^`]*`\}/))
const columnCard = anchor('RunColumn evidence card aria-label', column.match(/aria-label=\{`Inspect [^`]*`\}/))
check(
  'B2', '§5.1 the word is never omitted, and its one source is the projection', `${PANEL} entity row · ${NODES} EvidenceNodeCard · ${COLUMN} evidence card`,
  /aria-label=\{\`\$\{item\.kind\}: \$\{item\.name\}, \$\{item\.capture\}\`\}/.test(entityRow) && /,\s*\$\{evidence\.capture\},/.test(evidenceCard) && /,\s*\$\{item\.capture\},/.test(columnCard),
  'each entity control must speak the capture word carried on the entity itself — a word asserted locally at the surface (constant or literal) is the defect B1 was: the first derived or redacted entity is silently mislabelled',
)

// --- §5.2 Coverage, and the word "complete" --------------------------------------------------
// CONTRACT §12: "Each category publishes level: complete|partial|unavailable". TNG-162
// re-anchored B3 when it closed the gap: the fix is not a wider ternary in the panel but
// a level carried by the projection, so the probe now asserts both halves — the projector
// derives the level (with `partial` reachable: non-terminal agents, unpaired calls,
// unprojectable events, and the §10 projection_limit override), and the panel reads the
// published level instead of inventing one from a count. Neither half alone would keep
// the header honest.
const coverageFor = anchor('coverageFor', coverageModule.match(/function coverageFor\([\s\S]*?\n\}/))
const coverageBuild = anchor('projection coverage block', events.match(/coverage: \{[\s\S]*?\n {4}\},/))
// Both surfaces must go through it. A second reader that derived its own level would put the
// overclaim back, just on a screen size nobody audits.
const panelReadsLevel = /coverageSummary\(|coverageFor\(/.test(panel)
const columnReadsLevel = /coverageSummary\(|coverageFor\(/.test(column)
check(
  'B3', '§5.2 the level is carried by the projection, and partial is reachable', `${EVENTS} coverage block + ${COVERAGE} coverageFor`,
  /'partial'/.test(coverageBuild) && /\.level/.test(coverageFor) && !/> ?0/.test(coverageFor) && panelReadsLevel && columnReadsLevel,
  "the projection must publish a per-category level with a reachable 'partial', and every surface that states coverage must read it — a level invented from a count is the overclaim §5.2 forbids",
)

// CONTRACT §12, agents row: complete "when every spawned agent has identity and terminal
// evidence". The coverage block now consults the projected terminal facts (exitCode and
// the terminal statuses) instead of the headcount, so a run whose agents are all still
// working reads `partial`, not `complete`.
check(
  'B4', 'CONTRACT §12 agents complete only on terminal evidence', `${EVENTS} coverage.agents`,
  /exitCode|stopReason/.test(coverageBuild),
  'coverage.agents is list.length, so agents reads `complete` while every agent is still running; exitCode/stopReason are projected on ProjectedAgent and never consulted',
)

// CONTRACT §12, tools row: complete when "every call is paired or terminally failed".
// The projector tracks unpaired calls as `openCalls` and then strips that field at the
// projection boundary, so the one fact that decides tools coverage is computed and thrown away.
const agentsExit = anchor('projection agents mapping', events.match(/agents: list\.map\(\(\{[^}]*\}\) =>[^\n]*/))
check(
  'B5', 'CONTRACT §12 tools complete only when calls are paired', `${EVENTS} projection boundary`,
  !/openCalls: _/.test(agentsExit),
  'openCalls is computed per agent and discarded when the projection is returned; an unpaired tool call therefore counts toward `complete` for tools',
)

// --- report ----------------------------------------------------------------------------------
const failed = results.filter((result) => !result.pass)
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  ${result.spec}  (${result.where})`)
  if (!result.pass) console.log(`        ${result.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} contracts met.`)
process.exit(failed.length === 0 ? 0 : 1)
