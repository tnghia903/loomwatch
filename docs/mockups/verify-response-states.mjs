#!/usr/bin/env node
// TNG-90 §8 — response-node conformance of the shipped workspace against
// docs/TNG89_INTERACTION.md §3.3–3.4 (the answer in the canvas, `partial` and
// `failed`), docs/UX_REDESIGN.md §16 (never paraphrase a daemon error) and
// docs/RUN_PROVENANCE_CONTRACT.md §3 (terminal metadata carries a stable
// machine-readable error code).
//
// Asserts the CONTRACTS, not the current state: exits non-zero while the gaps
// recorded in docs/mockups/TNG90_IMPLEMENTATION_CONFORMANCE.md §8 are open, zero
// once they are closed, and 2 if the gate cannot answer at all — a drifted selector
// or an absent `ui/` input — so neither can ever read as a failure it did not observe.
//
//   node docs/mockups/verify-response-states.mjs
//
// Set LOOMWATCH_ROOT to run the same contracts against a patched copy of the
// tree; that is how the counterfactual (these five can pass) was demonstrated.

import { readFileSync } from 'node:fs'

const ROOT = process.env.LOOMWATCH_ROOT
  ? new URL(`file://${process.env.LOOMWATCH_ROOT.replace(/\/?$/, '/')}`)
  : new URL('../../', import.meta.url)
// This gate measures the *implementation*, so its inputs live in `ui/` and are outside the
// `docs/` tree a Gate B pin extracts. Run against an extracted pin it cannot answer, and it
// says so (exit 2) rather than raising — an unreadable stack trace in a reviewer's terminal
// is indistinguishable from a real conformance failure.
const read = (path) => {
  try {
    return readFileSync(new URL(path, ROOT), 'utf8')
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
const NODES = 'ui/src/components/run/StoryNodes.tsx'
const EVENTS = 'ui/src/lib/watch/events.ts'
const CLIENT = 'ui/src/lib/runs/client.ts'

const workspace = read(WORKSPACE)
const nodes = read(NODES)
const events = read(EVENTS)
const client = read(CLIENT)

const results = []
const check = (id, spec, where, pass, detail) => results.push({ id, spec, where, pass, detail })

function anchor(name, match) {
  if (!match) {
    console.error(`ANCHOR LOST: ${name} — the selector no longer matches. Re-anchor this probe before trusting any result.`)
    process.exit(2)
  }
  return match[0]
}

// The whole strip decision, from `const strip =` to the `: null` that ends the chain.
// Everything §3.4 puts in the strip is decided inside this one expression.
const strip = anchor('Workspace strip expression', workspace.match(/const strip = [\s\S]*?\n\s*: null\n/))
const outputCard = anchor('OutputNodeCard', nodes.match(/export function OutputNodeCard[\s\S]*?\n\}/))
const recordType = anchor('RunRecord type', client.match(/(?:export )?(?:type|interface) RunRecord[\s\S]*?\n\}/))
const phaseLadder = anchor('projectRun phase ladder', events.match(/let phase: RunPhase[\s\S]*?\n\s*else phase = [^\n]*\n/))

// A comment is not an implementation. Four of this gate's six contracts were greppable words
// before TNG-208's counterfactual (`defeat-response-states.mjs`) and two of them were being met
// by prose — `missing_canonical_response` appears in the ladder's own CONTRACT §4 comment, so D6
// scored a ladder that had stopped distinguishing the case. Every contract below reads the
// comment-stripped source; the raw region is kept only where the anchors live.
const decomment = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const outputCardCode = decomment(outputCard)
const stripCode = decomment(strip)
const ladderCode = decomment(phaseLadder)

// §3.4 governs the `partial`/`failed` branch specifically: that is where the code and the
// verbatim message live. The other two branches carry a reconnection sequence number and the
// operator's own cancellation, and neither is a daemon error — scoring them would let a fix in
// one branch pay for a regression in another.
const alertBranch = anchor('strip alert branch', stripCode.match(/tone: 'alert'[\s\S]*?\n\s*\}/))
const alertWatermark = anchor('strip alert watermark', alertBranch.match(/watermark: [^\n]*/))
const alertMessage = alertBranch.slice(alertBranch.indexOf('message:'), alertBranch.indexOf('watermark:'))

// --- §3.4 the code ---------------------------------------------------------------------------
// §3.4: "The strip carries the stable machine-readable error code and the verbatim message."
// CONTRACT §3: "Terminal metadata records the barrier facts, exit failures, stop reason, and
// stable machine-readable error code." The daemon is the only thing that knows the code.
//
// D1 is the modelling half. `RunRecord` carries `error` (verbatim) and `exitCode` and no code
// field at all, so the watermark — rendered at `var(--font-mono)`, the typography of a machine
// fact — is manufactured in the client from whether a *message string* happens to be non-empty.
// A code chosen by the presence of prose is not a code; it cannot disagree with the daemon,
// which is the only thing a code is for.
//
// Both halves have to be asserted where the value is *rendered*. The second conjunct was
// `/\b(errorCode|stopReason)\b/.test(strip)` — a bare identifier anywhere in the strip — and the
// message ternary reads `record?.errorCode` to choose its sentence, so that test stayed true for
// a watermark of `exitFact ?? 'no code reported'`: the field modelled, the field never shown, and
// the exit status standing in the slot the spec reserves for the code. Proven against this file
// as mutation 2 of `defeat-response-states.mjs`. Scoped to the watermark, it cannot.
const typeCarriesCode = /\b(errorCode|error_code|stopReason|stop_reason)\b/.test(recordType)
const watermarkReadsCode = /\b(errorCode|stopReason)\b/.test(alertWatermark)
check(
  'D1', '§3.4 / CONTRACT §3 the error code is carried, not invented', `${CLIENT} RunRecord · ${WORKSPACE} strip watermark`,
  typeCarriesCode && watermarkReadsCode,
  `RunRecord must carry the daemon's code and the strip watermark must render it (modelled: ${typeCarriesCode}, rendered: ${watermarkReadsCode}); otherwise the operator reads an invented token, or the exit status, in the slot the spec reserves for the daemon's own code`,
)

// D2 is the honesty half, and it is the one that actively misinforms. The `partial` watermark
// is `record?.error ? 'run_failed' : 'process_crashed'` — so *every* partial run with no error
// string is labelled `process_crashed`, including runs where nothing crashed and every agent
// succeeded (see D5). `process_crashed` is the spec's own example code for a crashed process.
//
// Scoped to the watermark expressions themselves. A `phase === 'failed'` comparison elsewhere
// in the strip is a branch, not a code, and an earlier draft of this probe failed on one —
// a check that cannot pass on a correct implementation proves nothing about a broken one.
const watermarks = stripCode.match(/watermark: [^,\n}]*/g) ?? []
if (watermarks.length === 0) {
  console.error('ANCHOR LOST: strip watermarks — no `watermark:` in the strip expression. Re-anchor this probe before trusting any result.')
  process.exit(2)
}
const INVENTED_CODE = /'(process_crashed|run_failed|failed|crashed|error)'/
check(
  'D2', '§3.4 no code the daemon did not emit', `${WORKSPACE} strip watermark`,
  !watermarks.some((entry) => INVENTED_CODE.test(entry)),
  'a hardcoded code literal sits in the watermark position, selected by a ternary on whether a message exists; a clean run that merely produced no answer is reported to the operator as a crashed process',
)

// --- §3.4 the message ------------------------------------------------------------------------
// UX_REDESIGN §16: "an error always carries the server's own message verbatim — LoomWatch never
// paraphrases a daemon error into something friendlier and less diagnostic." §3.4 repeats it.
//
// The fallbacks are not styled, worded or announced as anything other than the daemon speaking:
// same `.msg` slot, same strip, same accessible reading. The failed-run fallback is the clearest
// — it fills the verbatim-message slot with UI bookkeeping ("N evidence items kept") while the
// daemon's actual silence goes unmentioned. When there is no daemon message the honest strip
// says there is no daemon message.
//
// This was a denylist of the two paraphrases this repo happened to ship — 'The run did not
// complete normally.' and 'Run failed. Original prompt and …'. It could only ever catch a
// regression that had already been caught once: write a *third* invented sentence and the gate
// passed it (mutation 5 of `defeat-response-states.mjs`). So the test is inverted. §3.4 names
// exactly two sentences that may occupy this slot when the daemon says nothing, and any other
// sentence-shaped literal in the message expression is, by definition, English the UI made up.
// Adding to this set is a spec change, and it should read like one.
const SANCTIONED_SENTENCES = new Set([
  // §3.4: `missing_canonical_response` gets this plain-language second line, verbatim.
  'The run finished but no agent produced an answer.',
  // §16's "explicitly absent" form — it reports the silence rather than papering over it.
  'No error message was reported.',
])
// A sentence, not a code: codes are single tokens (`missing_canonical_response`), so requiring a
// space and terminal punctuation separates prose the operator reads from values it compares.
const invented = [...alertMessage.matchAll(/'([^']*)'|`([^`]*)`/g)]
  .map((hit) => hit[1] ?? hit[2])
  .filter((literal) => /\s/.test(literal) && /[.!?]$/.test(literal))
  .filter((sentence) => !SANCTIONED_SENTENCES.has(sentence))
check(
  'D3', '§3.4 / UX_REDESIGN §16 the message slot is verbatim or explicitly absent', `${WORKSPACE} strip message`,
  invented.length === 0,
  `invented English occupies the verbatim-message slot, indistinguishable from a daemon error in styling, wording and accessible name; the operator cannot tell which sentences the daemon actually said — found: ${invented.map((sentence) => `"${sentence}"`).join(', ')}`,
)

// --- §3.4 failed is the strip ----------------------------------------------------------------
// §3.4: "`failed` has no content, so the node is the strip: code, verbatim message, `[ Reuse ]`."
//
// D4: the body placeholder is unconditional on empty text, so a terminal failed run renders
// "No response text yet." — `yet` is a promise the run can no longer keep — and the node's
// accessible name still opens "Output response from <agent>" for an agent that produced none.
//
// This asked whether a phase word appeared *anywhere* in the card, which is the same bare-word
// mistake D5 was already fixed for. A refactor that keeps `isFailed` for a modifier class and
// drops it from the body and the accessible name restores the whole defect while leaving the
// word in the file — mutation 7 of `defeat-response-states.mjs`, green before this change. §3.4
// names two places, so the contract is asserted in those two places.
const bodyChain = anchor('OutputNodeCard body chain', outputCardCode.match(/\{data\.pending \? \([\s\S]*?\n\s*\)\}/))
const accessibleName = anchor('OutputNodeCard accessible name', outputCardCode.match(/aria-label=\{[^\n]*/))
const TERMINAL_GUARD = /terminalEmpty|isFailed|phase === 'failed'/
const bodyGuarded = TERMINAL_GUARD.test(bodyChain)
const nameGuarded = TERMINAL_GUARD.test(accessibleName)
check(
  'D4', '§3.4 failed renders as the strip, not a pending body', `${NODES} OutputNodeCard body · accessible name`,
  bodyGuarded && nameGuarded,
  `the empty-body placeholder "No response text yet." and the accessible name must each consult the phase (body: ${bodyGuarded}, name: ${nameGuarded}); chosen by \`!data.text\` alone, a terminally failed run tells the operator its answer is still coming and credits a response the agent never produced`,
)

// D5: the `[ Reuse ]` affordance §3.4 names. The prompt text does survive on the Prompt node
// (§12.2 `Original kept`), so this is a missing route, not lost data — but the node the
// operator is looking at when a run fails offers them nothing to do.
// A comment is not an affordance, and neither is a destructured identifier. This check was
// `/Reuse/i.test(outputCard)` — a bare word over the raw region — and it could not fail:
// delete the whole `[ Reuse ]` button and it still matched `reusePrompt` from
// `useCanvasActions()` on line 87 and the prose comment directly above this one. Proven by
// removing the element and watching D5 report PASS on an affordance the operator no longer
// has. So: strip comments, then require the element itself, carrying the visible label.
const reuseButton = (outputCardCode.match(/<button\b[\s\S]*?<\/button>/g) ?? [])
  .find((element) => /\[\s*Reuse\s*\]/.test(element))
check(
  'D5', '§3.4 failed offers [ Reuse ]', `${NODES} OutputNodeCard`,
  Boolean(reuseButton),
  'no Reuse action exists anywhere in ui/src; the failed response node is a dead end',
)

// --- §3.4 missing_canonical_response ---------------------------------------------------------
// §3.4 singles this case out: "`missing_canonical_response` gets the plain-language second line
// *'The run finished but no agent produced an answer.'*"
//
// The ladder's last rung is `phase = responseText ? 'succeeded' : 'partial'`, so a run where
// every agent finished cleanly and none was canonical lands in `partial` — and D2 then stamps
// it `process_crashed`. The one terminal state the spec asks to be named in plain language is
// the one the UI describes as a crash.
//
// The worst of the four blind contracts TNG-208 found here, and blind twice over. It searched
// `phaseLadder + strip` for `missing_canonical_response` — and the ladder's own CONTRACT §4
// comment contains that string, so the ladder half was met by prose from the day it was written.
// The `||` then meant either half alone carried the whole contract: delete the strip's branch
// (mutation 10) or the ladder's classification (mutation 11) and the gate stayed green for both.
// Two conjuncts, comment-stripped. The ladder must *distinguish* the case, the strip must *name*
// it, and the identifier the ladder uses is camelCase, so the snake_case code cannot stand in.
const ladderDistinguishes = /missingCanonicalResponse|missing_canonical_response/.test(ladderCode)
const stripNames = /missing_canonical_response/.test(stripCode) || /no agent produced an answer/.test(stripCode)
check(
  'D6', '§3.4 a run with no canonical response is named, not called a crash', `${EVENTS} phase ladder · ${WORKSPACE} strip`,
  ladderDistinguishes && stripNames,
  `the ladder must classify the terminal no-answer case apart from \`partial\` and the strip must name it (classified: ${ladderDistinguishes}, named: ${stripNames}); folded into \`partial\` with no distinguishing code or sentence, and combined with D2, the operator is told a clean run crashed`,
)

// --- report ----------------------------------------------------------------------------------
const failed = results.filter((result) => !result.pass)
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  ${result.spec}  (${result.where})`)
  if (!result.pass) console.log(`        ${result.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} contracts met.`)
process.exit(failed.length === 0 ? 0 : 1)
