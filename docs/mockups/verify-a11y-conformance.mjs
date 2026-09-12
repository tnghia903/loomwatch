#!/usr/bin/env node
// TNG-90 §6 — accessibility conformance of the shipped workspace against
// docs/TNG89_INTERACTION.md §6 (focus order, live regions, accessible names).
//
// Asserts the CONTRACTS, not the current state: this exits non-zero while the
// gaps recorded in docs/mockups/TNG90_IMPLEMENTATION_CONFORMANCE.md §6 are open,
// and exits zero once they are closed. Exit 2 means the gate could not answer at all
// — an absent `ui/` input — so it can never read as a failure it did not observe.
// Static source assertions — every rule
// below is anchored to a line the reviewer can open, so a passing run means the
// contract is expressed in a rendered path, not merely present somewhere.
//
//   node docs/mockups/verify-a11y-conformance.mjs
//
// TNG-158 re-anchoring — the contracts are unchanged; these selectors moved with the fix:
//   A2/A3 zone-head — the summaries moved from plain <div>s to disclosure <button>s
//     (§6.1 tab order), so the probe reads the button's opening tag instead of the div's.
//   A4/A5 politeAnnouncement — the `.find(Boolean)` first-match list was replaced by
//     slot-diffed candidate arrays feeding a FIFO queue hook (§6.3), so the probes now
//     anchor the candidate arrays, the queue hook and its wiring.
//   A1 additionally asserts the §6.4 entity name (kind, name, capture word) on both
//     surfaces that render the entity control — the panel row and the canvas card.

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
const WORKSPACE = 'ui/src/components/Workspace.tsx'
const STORY = 'ui/src/components/run/StoryNodes.tsx'
const COLUMN = 'ui/src/components/run/RunColumn.tsx'
const QUEUE = 'ui/src/lib/useAnnouncementQueue.ts'

const panel = read(PANEL)
const workspace = read(WORKSPACE)
const story = read(STORY)
const column = read(COLUMN)
const queue = read(QUEUE)

const results = []
const check = (id, spec, where, pass, detail) => results.push({ id, spec, where, pass, detail })

// A probe that has lost its anchor reads as a failure it did not actually observe.
// Every selector below is asserted to still match before any contract is judged on it,
// so "FAIL" always means the contract is unmet and never means "I could not look".
function anchor(name, match) {
  if (!match) {
    console.error(`ANCHOR LOST: ${name} — the selector no longer matches. Re-anchor this probe before trusting any result.`)
    process.exit(2)
  }
  return match[0]
}

// --- §6.4 Accessible names -----------------------------------------------------------------
// Entity — "<kind>: <name>, <capture word>" + the reason when `unavailable` (the panel
// renders the reason sentence for an unavailable category, where there are no rows to
// name). Asserted on every surface that renders the entity control: the panel row (A1's
// original anchor), the canvas EvidenceNodeCard and its RunColumn variant.
//
// TNG-170 re-anchoring — the contract is unchanged; these selectors moved with the fix:
// the capture word stopped being asserted at the surface (a panel constant plus two
// inline `recorded` literals) and is now carried by the entity itself — the projector
// sets `capture` on the projection (CONTRACT §8.1's accepted-event invariant) and every
// surface interpolates it. A stronger anchor than the constant it replaces: the word's
// one source is the projection, so a first genuinely `derived` or `redacted` entity is
// named truthfully with no surface edit, and a surface cannot regress to a local word.
const entityRow = anchor('ProvenancePanel entity row', panel.match(/<button type="button" className="pop-row"[^>]*>/))
// TNG-208 re-anchoring — the contracts are unchanged; two of the three surfaces were anchored on
// the very string they were checking. `Boolean(evidenceCard) && Boolean(columnCard)` could not be
// false: either the label matched, or `anchor()` had already exited 2. So dropping the capture
// word from the canvas card or the narrow card — the regression TNG-170 exists to prevent — came
// out of this gate as "re-anchor this probe", which reads to a reviewer as gate rot rather than
// as a conformance failure. Proven as mutations 2 and 3 of `defeat-a11y-conformance.mjs`.
//
// The anchors are the *elements* now and the names are checked inside them, so a card that stops
// carrying the capture word still anchors, and fails.
const evidenceCard = anchor('StoryNodes EvidenceNodeCard', story.match(/export function EvidenceNodeCard[\s\S]*?\n\}/))
const columnCard = anchor('RunColumn evidence card', column.match(/<button key=\{item\.id\}[\s\S]*?<\/button>/))
const named = {
  panel: /aria-label=\{\`\$\{item\.kind\}: \$\{item\.name\}, \$\{item\.capture\}\`\}/.test(entityRow),
  canvas: /aria-label=\{\`Inspect \$\{evidence\.kind\}: \$\{evidence\.name\}, \$\{evidence\.capture\},/.test(evidenceCard),
  column: /aria-label=\{\`Inspect \$\{item\.kind\}: \$\{item\.name\}, \$\{item\.capture\},/.test(columnCard),
}
check(
  'A1', '§6.4 entity name', `${PANEL} entity row · ${STORY} EvidenceNodeCard · ${COLUMN} evidence card`,
  named.panel && named.canvas && named.column,
  `entity names must read "<kind>: <name>, <capture word>" — a kind, a name or the capture word (sourced from the entity's own \`capture\` field) is missing from the accessibility tree (panel row: ${named.panel}, canvas card: ${named.canvas}, narrow column card: ${named.column})`,
)

// Summary chip — "<category>, <n> entities, <coverage word>".
// Anchored on the element by class, not by tag: A3 below asks whether the tag is a `<button>`,
// and an anchor that required one meant the answer was always yes (see A3).
const zoneHead = anchor('ProvenancePanel zone-head', panel.match(/<\w+[^>]*className="zone-head toggle t-micro"[^>]*>/))
check(
  'A2', '§6.4 summary chip name', `${PANEL} zone-head`,
  /aria-label=\{\`\$\{category\.label\}, \$\{count\} \$\{count === 1 \? 'entity' : 'entities'\}, \$\{coverageWord\(level\)\}\`\}/.test(zoneHead),
  'summary chip name must read "<category>, <n> entities, <coverage word>" — a count without its unit or coverage word is announced instead',
)

// --- §6.1 Tab order ------------------------------------------------------------------------
// "...filters → the six summaries in fixed order → expanded entities". A non-focusable
// element cannot occupy a tab position, and §6.1 requires `aria-expanded` to track every
// provenance disclosure.
//
// TNG-208: the `/<button/` half could not fail. `zoneHead` was anchored on a selector that began
// `<button type="button"`, so reverting the summaries to plain `<div>`s — the exact state TNG-158
// fixed, and invisible on screen because the class, the label and the click handler all survive
// it — exited 2 as a lost anchor instead of failing §6.1. Mutation 6 of
// `defeat-a11y-conformance.mjs`. The anchor is tag-agnostic now, so the tag is a real question.
const focusableTag = /^<button\b/.test(zoneHead)
const tracksExpanded = /aria-expanded=/.test(zoneHead)
check(
  'A3', '§6.1 summaries focusable', `${PANEL} zone-head`,
  focusableTag && tracksExpanded,
  `the six summaries must be focusable disclosure buttons whose \`aria-expanded\` tracks the open state (button: ${focusableTag}, aria-expanded: ${tracksExpanded}); a div with a click handler is not in the tab order at all`,
)

// --- §6.3 Live regions ---------------------------------------------------------------------
// Assertive: `failed`, `partial`, preflight blockers, and the stale-revision conflict.
// The preflight blocker ("N things to fix before this team can run") must be announced
// on the assertive channel, never through the polite queue.
const politeCandidates = anchor('Workspace politeCandidates', workspace.match(/const politeCandidates = \[[\s\S]*?\n\s*\]/))
const assertiveCandidates = anchor('Workspace assertiveCandidates', workspace.match(/const assertiveCandidates = \[[\s\S]*?\n\s*\]/))
check(
  'A4', '§6.3 preflight is assertive', `${WORKSPACE} assertiveCandidates`,
  !/documentChipState === 'invalid'/.test(politeCandidates) && /documentChipState === 'invalid'/.test(assertiveCandidates),
  'the preflight blocker (documentChipState === "invalid") must be published on the assertive candidates, not on the polite queue',
)

// A polite region built with `.find(Boolean)` announces at most ONE message per render.
// Everything below the first truthy entry is silently dropped — and `statusAnnouncement`
// (agent task-state churn, refreshed for 3 s at a time during a run) sits second, above
// save state, validation, disk notices and start errors. The contract is a real FIFO
// queue wired to every candidate, drained in order.
// TNG-208 found this the blindest of the five, in four separate ways, and all four share one
// mistake: it checked that the file contained the *parts* of a queue rather than that no message
// can be dropped. `defeat-a11y-conformance.mjs` mutations 9–12:
//
//   9.  `.find(Boolean)` restored — `politeWiring` was an `anchor()` on the exact binding it then
//       tested with `Boolean(...)`, so removing the binding exited 2 instead of failing.
//   10. a `break` in the effect loop — a perfect queue fed one message per render.
//   11. `startError` deleted from the candidates — the queue drains fine, the message never
//       arrives. The gate named `politeCandidates` in its own location string and never read it.
//   12. `if (spoken.current) return` in front of the push — push and shift both still there, the
//       hook still shaped like a queue, every message after the first dropped on the floor.
//
// So the contract is now read end to end, from the live region backwards: which binding feeds it,
// whether that binding is the queue, whether the queue can refuse a message, and whether every
// candidate §6.3 names is still in the array being drained.
const queueHook = anchor('useAnnouncementQueue hook', queue.match(/export function useAnnouncementQueue[\s\S]*?\n\}/))
const politeRegion = workspace.match(/<div aria-live="polite"[^>]*>\{(\w+)\}<\/div>/)
anchor('Workspace polite live region', politeRegion)
// Deliberately NOT an `anchor()`. The effect that feeds the queue is the mechanism under test, and
// the way this contract is broken is by deleting it: restoring `.find(Boolean)` removes the effect
// along with the binding, so anchoring here exited 2 on the one defect §6.3 was written against
// (mutation 9). An absent effect is a conformance failure, not a drifted selector, and it reads as
// one below. The surfaces either side of it — the live region and the candidate array — are still
// anchored, so a genuine rename cannot be mistaken for this.
const politeEffect = workspace.match(/const previous = priorPolite\.current[\s\S]*?\n\s*\}\)/)?.[0] ?? ''
// The identifier the region actually renders, and the enqueue function bound alongside it. A
// region fed by anything other than `useAnnouncementQueue` leaves this null, which is the failure.
const queueBinding = new RegExp(`const \\[${politeRegion[1]}, (\\w+)\\] = useAnnouncementQueue\\(\\)`).exec(workspace)
const enqueueName = queueBinding?.[1]
// Nothing between entering `enqueue` and the push may decide not to enqueue. The one permitted
// guard is the falsy-message check, which drops nothing an operator could have heard.
const enqueueBody = anchor('useAnnouncementQueue enqueue callback', queueHook.match(/const enqueue = useCallback\([\s\S]*?pending\.current\.push\(/))
const guardsBeforePush = [...enqueueBody.matchAll(/\breturn\b/g)].length
// §6.3's polite channel, by name: agent status churn, save state, disk notices, start errors.
// (Validation blockers are A4's — they belong on the assertive channel.)
const POLITE_CANDIDATES = ['statusAnnouncement', "documentChipState === 'saving'", "documentChipState === 'saved'", "documentChipState === 'error'", 'diskNotice', 'startError']
const dropped = POLITE_CANDIDATES.filter((candidate) => !politeCandidates.includes(candidate))
const a5 = {
  regionIsQueue: Boolean(queueBinding) && !/\.find\(Boolean\)/.test(workspace),
  queueIsFifo: /pending\.current\.push\(/.test(queueHook) && /pending\.current\.shift\(\)/.test(queueHook),
  queueTakesEveryMessage: guardsBeforePush === 1 && /if \(!message\) return/.test(enqueueBody),
  effectFeedsEveryCandidate: Boolean(politeEffect) && Boolean(enqueueName) && new RegExp(`${enqueueName}\\(message\\)`).test(politeEffect)
    && /index < politeCandidates\.length/.test(politeEffect) && !/\b(break|continue)\b/.test(politeEffect),
  candidatesIntact: dropped.length === 0,
}
check(
  'A5', '§6.3 no message is dropped', `${QUEUE} · ${WORKSPACE} politeCandidates · polite live region`,
  Object.values(a5).every(Boolean),
  `the polite channel must drain a FIFO queue fed by every candidate message — ${Object.entries(a5).filter(([, ok]) => !ok).map(([name]) => name).join(', ')} unmet${dropped.length ? `; missing candidates: ${dropped.join(', ')}` : ''}`,
)

// --- report --------------------------------------------------------------------------------
const failed = results.filter((result) => !result.pass)
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  ${result.spec}  (${result.where})`)
  if (!result.pass) console.log(`        ${result.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} contracts met.`)
process.exit(failed.length === 0 ? 0 : 1)