#!/usr/bin/env node
// TNG-90 §6 — accessibility conformance of the shipped workspace against
// docs/TNG89_INTERACTION.md §6 (focus order, live regions, accessible names).
//
// Asserts the CONTRACTS, not the current state: this exits non-zero while the
// gaps recorded in docs/mockups/TNG90_IMPLEMENTATION_CONFORMANCE.md §6 are open,
// and exits zero once they are closed. Static source assertions — every rule
// below is anchored to a line the reviewer can open, so a passing run means the
// contract is expressed in a rendered path, not merely present somewhere.
//
//   node docs/mockups/verify-a11y-conformance.mjs

import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

const PANEL = 'ui/src/components/run/ProvenancePanel.tsx'
const WORKSPACE = 'ui/src/components/Workspace.tsx'

const panel = read(PANEL)
const workspace = read(WORKSPACE)

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
// Entity — "<kind>: <name>, <capture word>" + the reason when `unavailable`.
// The panel's entity rows are the entity control that ships today. Their accessible
// name is computed from child text (name + ordinal + offset); the status glyph is
// aria-hidden, so neither kind nor capture word reaches the accessibility tree.
const entityRow = anchor('ProvenancePanel entity row', panel.match(/<button type="button" className="pop-row"[^>]*>/))
check(
  'A1', '§6.4 entity name', `${PANEL} entity row`,
  /aria-label=/.test(entityRow),
  'entity row button has no aria-label; name falls back to "<name> #NN · <offset>" — no kind, no capture word',
)

// Summary chip — "<category>, <n> entities, <coverage word>".
const zoneHead = anchor('ProvenancePanel zone-head', panel.match(/<div className="zone-head t-micro">[\s\S]{0,400}?<\/div>/))
check(
  'A2', '§6.4 summary chip name', `${PANEL} zone-head`,
  /entit(y|ies)/.test(zoneHead),
  'summary reads "<category> <n> <coverage>" — the contract\'s "entities" noun is absent, so a count with no unit is announced',
)

// --- §6.1 Tab order ------------------------------------------------------------------------
// "...filters → the six summaries in fixed order → expanded entities". A summary
// rendered as a plain <div> cannot take focus and so cannot occupy a tab position.
check(
  'A3', '§6.1 summaries focusable', `${PANEL} zone-head`,
  /<button/.test(zoneHead),
  'the six summaries are non-focusable <div>s; they cannot occupy the tab positions §6.1 assigns them',
)

// --- §6.3 Live regions ---------------------------------------------------------------------
// Assertive: `failed`, `partial`, preflight blockers, and the stale-revision conflict.
// The preflight blocker ("N things to fix before this team can run") is announced
// only through the polite queue.
const politeList = anchor('Workspace politeAnnouncement', workspace.match(/const politeAnnouncement = \[[\s\S]*?\]\s*\.find\(Boolean\)[^\n]*/))
check(
  'A4', '§6.3 preflight is assertive', `${WORKSPACE} politeAnnouncement`,
  !/documentChipState === 'invalid'/.test(politeList),
  'the preflight blocker (documentChipState === "invalid") sits on the polite channel; §6.3 lists preflight blockers as assertive',
)

// A polite region built with `.find(Boolean)` announces at most ONE message per
// render. Everything below the first truthy entry is silently dropped — and
// `statusAnnouncement` (agent task-state churn, refreshed for 3 s at a time during a
// run) sits second, above save state, validation, disk notices and start errors.
check(
  'A5', '§6.3 no message is dropped', `${WORKSPACE} politeAnnouncement`,
  !/\.find\(Boolean\)/.test(politeList),
  'polite queue collapses N pending messages to the first truthy one; during a live run statusAnnouncement preempts save, validation and disk announcements for 3 s at a time',
)

// --- report --------------------------------------------------------------------------------
const failed = results.filter((result) => !result.pass)
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  ${result.spec}  (${result.where})`)
  if (!result.pass) console.log(`        ${result.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} contracts met.`)
process.exit(failed.length === 0 ? 0 : 1)
