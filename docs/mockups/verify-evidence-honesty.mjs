#!/usr/bin/env node
// TNG-90 §7 — evidence-quality conformance of the shipped workspace against
// docs/TNG89_INTERACTION.md §5 (capture states, coverage, the word "complete")
// and docs/RUN_PROVENANCE_CONTRACT.md §8.1 / §12.
//
// Asserts the CONTRACTS, not the current state: exits non-zero while the gaps
// recorded in docs/mockups/TNG90_IMPLEMENTATION_CONFORMANCE.md §7 are open, zero
// once they are closed, and 2 if a selector drifted — so a lost anchor can never
// read as a failure it did not observe.
//
//   node docs/mockups/verify-evidence-honesty.mjs

import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

const PANEL = 'ui/src/components/run/ProvenancePanel.tsx'
const NODES = 'ui/src/components/run/StoryNodes.tsx'
const COLUMN = 'ui/src/components/run/RunColumn.tsx'
const EVENTS = 'ui/src/lib/watch/events.ts'

const panel = read(PANEL)
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
// B1 is the modelling contract, and it survives TNG-158. That issue landed the *word*
// (B2) by hardcoding it: a module constant in the panel and a bare `recorded` literal
// inside the template string of two other surfaces. The value is correct today — every
// projected item is built from an accepted event — but it is asserted in three places
// and typed in none, so the first `derived` or `redacted` entity makes two of those
// three silently wrong with no compiler seam to catch it. Model it on the entity.
const evidenceType = anchor('Evidence interface', events.match(/export interface Evidence \{[\s\S]*?\n\}/))
check(
  'B1', '§5.1 / CONTRACT §8.1 capture is modelled', `${EVENTS} interface Evidence`,
  /\n\s*capture\b/.test(evidenceType),
  'Evidence has no `capture` field; the word is hardcoded at three call sites instead, so CONTRACT §8.1\'s four states are unrepresentable and the one true value has no single source',
)

// The word, on the three surfaces that render an entity control. Scoped to the controls
// themselves — the panel's zone-head says "Not captured" about a *category*, which is
// §5.2's coverage word and a different axis from an entity's capture state.
// Case-insensitive: §5.1's table capitalizes the chip label, but inside an accessible
// name ("tool: Fetch page #04, recorded") lowercase is the correct register, and §6.4's
// format lowercases the kind beside it.
const entityRow = anchor('ProvenancePanel entity row', panel.match(/<button type="button" className="pop-row"[\s\S]*?<\/button>/))
const evidenceCard = anchor('EvidenceNodeCard aria-label', nodes.match(/aria-label=\{`Inspect [^`]*`\}/))
const columnCard = anchor('RunColumn evidence card aria-label', column.match(/aria-label=\{`Inspect [^`]*`\}/))
const CAPTURE_WORD = /recorded|derived|redacted|not captured|captureWord/i
check(
  'B2', '§5.1 the word is never omitted', `${PANEL} entity row · ${NODES} EvidenceNodeCard · ${COLUMN} evidence card`,
  [entityRow, evidenceCard, columnCard].every((source) => CAPTURE_WORD.test(source)),
  'an entity control reaches the accessibility tree with no capture word, spending its one status channel on run status (succeeded/failed/running) — which answers a different question',
)

// --- §5.2 Coverage, and the word "complete" --------------------------------------------------
// CONTRACT §12: "Each category publishes level: complete|partial|unavailable". TNG-162
// re-anchored B3 when it closed the gap: the fix is not a wider ternary in the panel but
// a level carried by the projection, so the probe now asserts both halves — the projector
// derives the level (with `partial` reachable: non-terminal agents, unpaired calls,
// unprojectable events, and the §10 projection_limit override), and the panel reads the
// published level instead of inventing one from a count. Neither half alone would keep
// the header honest.
const coverageFor = anchor('coverageFor', panel.match(/function coverageFor\([\s\S]*?\n\}/))
const coverageBuild = anchor('projection coverage block', events.match(/coverage: \{[\s\S]*?\n {4}\},/))
check(
  'B3', '§5.2 the level is carried by the projection, and partial is reachable', `${EVENTS} coverage block + ${PANEL} coverageFor`,
  /'partial'/.test(coverageBuild) && /\.level/.test(coverageFor) && !/> ?0/.test(coverageFor),
  "the projection must publish a per-category level with a reachable 'partial', and the panel must read it — coverageFor inventing a level from a count is the overclaim §5.2 forbids",
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
