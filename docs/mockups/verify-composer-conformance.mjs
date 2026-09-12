#!/usr/bin/env node
// TNG-90 §1 — prompt-composer conformance of the shipped workspace against
// docs/TNG89_INTERACTION.md §1.1–§1.7 (geometry and growth, keyboard, preflight,
// the dirty document, the save/start race, idempotency, and what the composer
// deliberately does not have), as revised by §11.6 (TNG-115 narrow composition).
//
// Asserts the CONTRACTS, not the current state: exits non-zero while the gaps
// recorded in docs/mockups/TNG90_IMPLEMENTATION_CONFORMANCE.md §10 are open, zero
// once they are closed, and 2 if the gate cannot answer at all — a drifted selector
// or an absent `ui/` input — so neither can ever read as a failure it did not observe.
//
//   node docs/mockups/verify-composer-conformance.mjs
//
// Set LOOMWATCH_ROOT to run the same contracts against a patched copy of the tree;
// that is how the counterfactual (every one of these can pass) was demonstrated.
//
// Row C9-B is the daemon half: `POST /api/runs` accepts `expectedRevision` and refuses a
// stale one by a stable code (TNG-194), so a run can actually be bound to the bytes the
// save wrote. Fourteen of the fourteen rows pass today. Every row passing is recent — the
// previously-red rows stay in place on purpose: a gate whose every row is green cannot
// show that its selectors still bind, and C8, C10, C11 and C12 guard rules that a
// plausible "fix" to a green row would break.

import { readFileSync } from 'node:fs'

const ROOT = process.env.LOOMWATCH_ROOT
  ? new URL(`file://${process.env.LOOMWATCH_ROOT.replace(/\/?$/, '/')}`)
  : new URL('../../', import.meta.url)

// This gate measures the *implementation*, so its inputs live in `ui/` (and the daemon row
// C9-B reads `crates/loomwatch-backend/`) and are outside the `docs/` tree a Gate B pin
// extracts. Run against an extracted pin it cannot answer, and it says so (exit 2) rather
// than raising — an unreadable stack trace in a reviewer's terminal is indistinguishable
// from a real conformance failure.
const read = (path) => {
  try {
    return readFileSync(new URL(path, ROOT), 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    console.error(`CANNOT RUN — the shipped input is missing:
    ${path}
    (production source, NOT part of a pinned \`docs/\` artifact)

This gate measures the shipped implementation against the approved design, so it needs
the \`ui/\` and \`crates/\` trees and only answers from a full repo checkout. It is not a
statement about the pinned artifact, and this is not a conformance failure.`)
    process.exit(2)
  }
}

const COMPOSER = 'ui/src/components/composer/Composer.tsx'
const WORKSPACE = 'ui/src/components/Workspace.tsx'
const RUNTIME_CSS = 'ui/src/styles/runtime.css'
const RUNS_CLIENT = 'ui/src/lib/runs/client.ts'
const TEAM_CLIENT = 'ui/src/lib/team-file/client.ts'
const RUNS_BACKEND = 'crates/loomwatch-backend/src/runs.rs'

// A row has to be answered by the program, never by the prose sitting next to it.
// `defeat-composer-conformance.py` (§10.6) restored each recorded defect one at a time and
// found three rows that survived their own: C2 matched `focused` in the comment above the
// height effect, C9 matched `expectedRevision` in the comment above the `launch` call, and
// C12's `if (!saved) … return` proximity test matched the word "returned" in the comment two
// lines below it. All three were green with the behaviour removed. So every input is read
// with its comments stripped, and what the gate matches is what the program does.
//
// Whole-line `//` only. A trailing comment cannot be removed without a tokenizer — `//` also
// appears mid-line inside string literals in the Rust input (`"https://…"`) — and no contract
// here is expressible in a single trailing comment, so the conservative rule loses nothing.
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const composer = code(read(COMPOSER))
const workspace = code(read(WORKSPACE))
const css = code(read(RUNTIME_CSS))
const runsClient = code(read(RUNS_CLIENT))
const teamClient = code(read(TEAM_CLIENT))
const runsBackend = code(read(RUNS_BACKEND))

const results = []
const check = (id, spec, where, pass, detail) => results.push({ id, spec, where, pass, detail })

function anchor(name, match) {
  if (!match) {
    console.error(`ANCHOR LOST: ${name} — the selector no longer matches. Re-anchor this probe before trusting any result.`)
    process.exit(2)
  }
  return match
}

/** The body of a `const <name> = useCallback(`/`useMemo(` up to its dependency array. */
function callbackBody(source, name, label) {
  const start = anchor(label, source.match(new RegExp(`const ${name}(?::[^=]+)? = use(?:Callback|Memo)\\(`)))
  const from = start.index
  const end = source.indexOf('\n  }, [', from)
  anchor(`${label} — dependency array`, end === -1 ? null : true)
  return source.slice(from, end)
}

// --- anchors ---------------------------------------------------------------------------------
const composerState = callbackBody(workspace, 'composerState', 'Workspace composerState')
const launch = callbackBody(workspace, 'launch', 'Workspace launch()')
const submit = callbackBody(workspace, 'submit', 'Workspace submit()')

const globalKeys = (() => {
  const start = anchor('Workspace global keydown handler', workspace.match(/function onKeyDown\(event: KeyboardEvent\) \{/))
  const end = workspace.indexOf(`window.addEventListener('keydown'`, start.index)
  anchor('Workspace global keydown — listener registration', end === -1 ? null : true)
  return workspace.slice(start.index, end)
})()

const composerKeys = (() => {
  const start = anchor('Composer onKeyDown', composer.match(/function onKeyDown\(event: React\.KeyboardEvent/))
  const end = composer.indexOf('\n  }', start.index)
  return composer.slice(start.index, end)
})()

const growth = (() => {
  const start = anchor('Composer textarea auto-grow effect', composer.match(/useEffect\(\(\) => \{[\s\S]*?element\.style\.height/))
  const end = composer.indexOf('\n  }, [', start.index)
  anchor('Composer auto-grow effect — dependency array', end === -1 ? null : true)
  return composer.slice(start.index, composer.indexOf(']', end) + 1)
})()

const textareaRule = anchor(
  `${RUNTIME_CSS} .lw-composer textarea rule`,
  css.match(/\.lw-composer textarea \{[\s\S]*?\}/),
)[0]

const narrowBlocks = css.match(/@media \(max-width: 767px\) \{[\s\S]*?\n\}/g) ?? []
anchor(`${RUNTIME_CSS} narrow media blocks`, narrowBlocks.length > 0 ? true : null)

const startRun = (() => {
  const start = anchor(`${RUNS_CLIENT} startRun()`, runsClient.match(/export async function startRun\(/))
  const end = runsClient.indexOf('\n}', start.index)
  return runsClient.slice(start.index, end)
})()

const terminalsBranch = anchor(
  'Workspace pipeline-terminal preflight branch',
  composerState.match(/if \(doc\.mode === 'pipeline' && terminals !== 1\)[^\n]*/),
)[0]

// --- §1.2 keyboard ---------------------------------------------------------------------------
// "`⌘↵` / `Ctrl↵` — **submit** — from anywhere in the app, including a focused canvas."
// The only ⌘↵ binding lives on the composer's own textarea. The global handler's `Enter`
// branch does not test the modifier at all, so ⌘↵ on a focused canvas with an agent selected
// dispatches `loomwatch:rename-agent` — the app answers the submit shortcut by offering a
// rename. The command palette advertises `⌘↵` for "Run the team…" and only focuses the field.
check(
  'C1', '§1.2 ⌘↵ submits from anywhere in the app, including a focused canvas', `${WORKSPACE} global keydown`,
  /mod[\s\S]{0,80}Enter/.test(globalKeys) || /Enter[\s\S]{0,80}\bmod\b/.test(globalKeys),
  'the global handler has no modifier+Enter branch; ⌘↵ only works while the textarea itself has focus, and outside it the unguarded `Enter` branch fires rename-agent instead',
)

// "`Esc` — blur and collapse to one line, text preserved."
// The height is written by an effect keyed on `[value]` only, so a composer grown to its cap
// stays grown after Escape blurs it. Text is preserved (correct); the collapse never happens.
//
// Either mechanism closes this: a height effect that depends on focus, or an Escape branch
// that resets the height itself. The second leg used to read `/Escape/` alone, which is the
// weaker claim that the composer *handles* Escape — §10.6 defeated the first leg and the row
// stayed green on an Escape branch that only blurs, which is the recorded defect exactly.
// Both legs now have to reach the height.
check(
  'C2', '§1.2 Esc collapses the grown composer back to one line', `${COMPOSER} auto-grow effect`,
  /focused/.test(growth) || /Escape[\s\S]{0,200}style\.height/.test(composerKeys),
  'the auto-grow effect depends on `[value]` alone and nothing resets the height on blur, so Escape blurs the field and leaves the composer at its grown height',
)

// --- §1.1 geometry and growth -----------------------------------------------------------------
// "Input | single line, grows to **5 lines** then scrolls internally".
// Compare against the rule's own line-height rather than a literal, so a type-scale change
// cannot silently turn this green.
const lineHeight = Number(anchor(`${RUNTIME_CSS} textarea line-height`, textareaRule.match(/font:[^;]*?\d+px\/(\d+)px/))[1])
const maxHeight = Number(anchor(`${RUNTIME_CSS} textarea max-height`, textareaRule.match(/max-height:\s*(\d+)px/))[1])
const jsClamp = Number(anchor(`${COMPOSER} auto-grow clamp`, growth.match(/Math\.min\((\d+),/))[1])
check(
  'C3', '§1.1 the input grows to 5 lines, then scrolls internally', `${RUNTIME_CSS} + ${COMPOSER}`,
  maxHeight === 5 * lineHeight && jsClamp === 5 * lineHeight,
  `caps at ${maxHeight}px (CSS) / ${jsClamp}px (JS) against a ${lineHeight}px line — ${maxHeight / lineHeight} lines, not the approved 5`,
)

// --- §1.3 preflight ---------------------------------------------------------------------------
// "**pipeline has ≠ 1 terminal agent** | *"A pipeline run needs exactly one final agent. This
// one has two: `author`, `qa`."* | `[ Show on canvas ]` selects both".
// Two promises in one row, each independently fixable, so each is its own row here.
check(
  'C4', '§1.3 the pipeline-terminal blocker names the offending agents', `${WORKSPACE} composerState`,
  /nodeNames|terminalNames|\.data\.label/.test(terminalsBranch),
  'the line interpolates a count only ("— 2 found"), so the operator is told how many final agents exist but never which',
)
check(
  'C5', '§1.3 [ Show on canvas ] selects the offending agents', `${WORKSPACE} composerState`,
  /select/i.test(terminalsBranch),
  'the action calls `flow.fitView` — it frames the whole canvas and selects nothing, so on a large team it identifies the offending agents no better than the line did',
)

// --- §1.4 / §1.6 the save step and the start step ---------------------------------------------
// §1.4: "the composer holds `Saving…` until the run is created — so the two steps stay legible
// as two steps." §1.6: "The button shows `Starting…`, disabled."
// `starting` is the run-creation flag and `pendingPrompt` the save flag; both return `saving`,
// so starting a run on a CLEAN document says *"Saving research-team.yaml — the run is created
// against the revision this write returns."* while no write is happening at all.
const startingBranch = anchor(
  'Workspace start-in-flight branch',
  composerState.match(/if \([^)]*\bstarting\b[^)]*\)[^\n]*/),
)[0]
check(
  'C6', '§1.4/§1.6 the start step is labelled `Starting…`, not `Saving…`', `${WORKSPACE} composerState · ${COMPOSER} ComposerState`,
  /'starting'/.test(composer.match(/export type ComposerState =[\s\S]*?\n\n/)?.[0] ?? '') && !/kind: 'saving'/.test(startingBranch),
  'the run-creation flag returns `{ kind: \'saving\' }`, so a clean document reports a save that never happens and `Starting…` is unreachable — the two steps §1.4 insists stay legible are collapsed into one',
)

// --- §1.6 idempotency --------------------------------------------------------------------------
// "`⌘↵` generates one start key and holds it for the life of the attempt… A connection loss
// during submit **never** retries blind: the client re-`GET`s by start key."
// `startRun` posts `{teamPath, prompt}`. On a thrown fetch the catch sets an error and leaves
// the prompt in the field with Run re-enabled, so the operator's natural re-press is exactly
// the blind retry this clause forbids — and the daemon has no key to collapse it against.
check(
  'C7', '§1.6 the start request carries a start key', `${RUNS_CLIENT} startRun()`,
  /startKey|idempotencyKey|Idempotency-Key/i.test(startRun),
  'the POST body is `{ teamPath, prompt }` with no key in body or headers, so a submit whose response is lost cannot be resolved by re-GET and a re-press creates a second run',
)

// --- §1.4 / §1.5 the snapshot the run actually executes ----------------------------------------
// §1.4: "`Save & run` is one intent, two requests: conditional `PUT /api/team` (`If-Match` the
// loaded revision), then `POST /api/runs` with `expectedRevision` = the revision the PUT
// returned." §1.5 then relies on that field: "If `PUT` returns `412` or `POST /api/runs`
// returns a revision conflict… **No run is created.**"
check(
  'C8', '§1.4 the save half of Save & run is conditional on the loaded revision', `${TEAM_CLIENT} saveTeamFile()`,
  /'If-Match'/.test(teamClient),
  'the PUT is unconditional, so Save & run can overwrite a revision the operator never saw',
)
check(
  'C9', '§1.4/§1.5 the start half pins the revision the save returned', `${RUNS_CLIENT} startRun() · ${WORKSPACE} submit()`,
  /expectedRevision/.test(startRun + submit),
  'nothing binds the run to the bytes the PUT wrote, so a disk write landing between the save and the start is executed silently — the exact "ran what is on disk, not what is on screen" case §1.4 exists to prevent (needs a daemon-side field; cf. TNG-166/TNG-168)',
)
check(
  'C9-B', '§1.4/§1.5 the daemon accepts `expectedRevision` and refuses a stale one by stable code', `${RUNS_BACKEND} StartRunRequest · prepare_run() · start_run()`,
  /expected_revision: Option<String>/.test(runsBackend)
    && /alias = "expectedTeamRevision"/.test(runsBackend)
    && /StaleRevision \{ current: String \}/.test(runsBackend)
    && /"code": STALE_TEAM_REVISION/.test(runsBackend)
    && /"currentTeamRevision"/.test(runsBackend),
  'the daemon does not yet honour an expected revision at start time, so the client cannot bind a run to the bytes the save wrote even after sending it (cf. TNG-166/TNG-168)',
)

// --- rows that pass today, and are here to stay passing ---------------------------------------
// §1.1's "Below 768 | composer hidden" row is SUPERSEDED by §11.6, whose failure 22 reads
// "Narrow mode loses submission… **Fail.**" Hiding the composer below 768 would satisfy the
// older row and fail the newer one. Encoded here so that supersession is enforced, not recalled.
// The selector must bind `.lw-composer` ITSELF, never a descendant: the narrow block legitimately
// carries `.lw-composer .comp-note { display: none }`, and a looser pattern reads that as the
// composer being hidden — a red row for a rule that is working.
check(
  'C10', '§11.6 f22 narrow keeps the composer (supersedes §1.1\'s hidden-composer row)', `${RUNTIME_CSS} @media (max-width: 767px)`,
  !narrowBlocks.some((block) => /(^|[,{}\n])\s*\.lw-composer\s*(,[^{]*)?\{[^}]*display:\s*none/.test(block)),
  'the narrow block hides `.lw-composer`, which satisfies the superseded §1.1 row by failing §11.6 acceptance failure 22',
)

// §1.7: "No model picker, no temperature, no agent selector, no 'run only this node', no
// attachments. The team file is the configuration; the composer's only job is the goal."
check(
  'C11', '§1.7 the composer carries no second source of run configuration', COMPOSER,
  !/temperature|model(Picker|Select)|attachment|<input[^>]*type="file"/i.test(composer),
  'a configuration control has appeared in the composer, competing with the team file the snapshot rule exists to make authoritative',
)

// §1.4: "There is **no 'run without saving.'**"
check(
  'C12', '§1.4 a dirty document is saved before the run, and a failed save starts nothing', `${WORKSPACE} submit()`,
  /documentChipState/.test(submit) && /doc\.save\(\)/.test(submit) && /if \(!saved\)[\s\S]{0,120}return/.test(submit),
  'submit() can reach `launch` without a successful save, which runs either stale or unreviewed bytes',
)

// §1.5: "the composer returns to its pre-submit state with the prompt text **preserved**.
// Losing a typed goal to a file race would be unforgivable and is the whole reason the text is
// held until the run id comes back."
check(
  'C13', '§1.5 the prompt is held until the run id comes back', `${WORKSPACE} launch() · submit()`,
  !/setComposerText\(''\)/.test(submit) && /await startRun\([\s\S]*?setComposerText\(''\)/.test(launch),
  'the prompt is cleared on a path that does not yet hold a run id, so a save/start race loses a typed goal',
)

// --- report ------------------------------------------------------------------------------------
const failed = results.filter((result) => !result.pass)
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  ${result.spec}  (${result.where})`)
  if (!result.pass) console.log(`        ${result.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} contracts met.`)
process.exit(failed.length === 0 ? 0 : 1)
