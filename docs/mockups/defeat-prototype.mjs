#!/usr/bin/env node
/* TNG-90 — the counterfactual pass for verify-prototype.mjs.
 *
 * verify-prototype.mjs is the *second* of exactly two gates that read the artifact the board
 * is being asked to approve, and the only evidence for it anywhere is the word "pass". It is
 * fail-fast: one `assert` throws and the run stops, so a green run prints a single sentence
 * covering roughly sixty contracts and says nothing about which of them were exercised. Its
 * sibling `verify-tng90-states.mjs` at least printed a count; this one prints a claim.
 *
 * So this reproduces, one at a time, the defects verify-prototype.mjs claims to catch — each
 * one a regression this repo has actually shipped or argued about — and requires the gate to
 * go red *on that contract's own assertion message*. A mutation that lands and leaves the gate
 * green means the contract is decorative. A mutation that reddens some *other* contract first
 * means the target was never reached, which is not proof of anything either; both exit 1.
 *
 *   node docs/mockups/defeat-prototype.mjs
 *   node docs/mockups/defeat-prototype.mjs --only 1,4     # a subset, by number
 *   node docs/mockups/defeat-prototype.mjs --no-control   # skip the unmutated control run
 *
 * The pinned artifact is never touched. Each mutation is applied to a *copy*, in a scratch
 * directory alongside a copy of the gate — the gate resolves its artifact relative to its own
 * file, so a copied pair measures the mutant with the shipped probe, byte for byte, and
 * `docs/mockups/prototype-standalone.html` keeps its `a339e26a…` hash throughout.
 *
 * Run 0 is an unmutated copy, and it has to come out green. A column of reds proves nothing if
 * the copy-pair harness reddens on its own — the control run is what makes the rest mean "the
 * mutation did this" rather than "something in here is broken".
 *
 * A mutation whose anchor does not appear the expected number of times is a *harness* error,
 * not a caught defect: a replacement that silently no-ops changes nothing and then reads as an
 * uncaught regression. That case exits 2 and says so.
 *
 * Each run drives headless Chrome for ~18s, so a full pass is about four minutes.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const gate = join(here, 'verify-prototype.mjs')
const artifact = join(here, 'prototype-standalone.html')
const scratch = join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'defeat-prototype')

const source = readFileSync(artifact, 'utf8')

/* Each entry: the regression, the edit that reproduces it, and the assertion message that has
   to carry the failure. `expect` is a substring of the message verify-prototype.mjs throws —
   the messages interpolate JSON state, so matching a prefix is the only stable form.
   `edits` carries more than one replacement where a contract is defended in two places and
   breaking one leaves the other holding it. */
const mutations = [
  {
    name: "the board's own gesture lands the row somewhere else",
    why: 'The rejection was "I still cannot drag the agent from the library". A drop that routes to wiring and then places the node anywhere but the release point is the same complaint with extra steps, and only a position assertion can tell them apart.',
    from: '  const n = placeResource(c.ref, p.x - s.w / 2, p.y - s.h / 2);',
    to: '  const n = placeResource(c.ref, 40, 40);',
    expect: 'Press-drag-release from the library did not land',
  },
  {
    name: 'the grab handle is withheld off the wiring screen again',
    why: 'cd5e162 removed the drag *look* from every screen but wiring, which is exactly what left the board\'s screenshot looking inert. The pointer carry serves the gesture everywhere, so the handle has to be there everywhere.',
    from: "    ${usable ? '<span class=\"drag-dots t-body\" aria-hidden=\"true\">⠿</span>' : ''}",
    to: "    ${usable && wiringScreen ? '<span class=\"drag-dots t-body\" aria-hidden=\"true\">⠿</span>' : ''}",
    expect: 'Usable library rows lack the grab handle on the canvas screen',
  },
  {
    name: 'draggable="true" leaks onto screens with no drop wiring',
    why: 'The inverse error, and the one cd5e162 was fixing: advertising the HTML5 drag where dragover/drop are not wired gets the gesture refused by the UA, which reads to the operator as a broken row.',
    from: '  const nativeDrag = usable && wiringScreen;',
    to: '  const nativeDrag = usable;',
    expect: 'Library rows claim draggable="true" on the canvas screen',
  },
  {
    name: 'the app shell becomes text-selectable',
    why: 'In WebKit, pressing on selectable text inside a draggable element starts a selection and the drag never arms. This is the defect five self-checks and a byte verifier all passed while Safari stayed broken.',
    from: 'never remove those. */\n  user-select: none;\n  -webkit-user-select: none;\n}',
    to: 'never remove those. */\n  user-select: text;\n  -webkit-user-select: text;\n}',
    expect: 'App shell is text-selectable',
  },
  {
    name: 'the -webkit- fallback is stripped from the shipped bytes',
    why: 'Chromium honours the unprefixed property, so this mutation is invisible to every probe in this harness except the byte check — and it is the one browser the board does not review in. A Chrome-only gate that dropped the byte check would call this file clean.',
    from: 'never remove those. */\n  user-select: none;\n  -webkit-user-select: none;\n}',
    to: 'never remove those. */\n  user-select: none;\n}',
    expect: 'The -webkit-user-select fallback was stripped from the shipped bytes',
  },
  {
    name: 'locking the shell takes the answer with it',
    why: 'The inverse invariant, and the one a drag fix is most likely to break: the operator still has to be able to copy the answer, the command output, their own prompt, and to select inside a field.',
    from: '#stage [contenteditable] {\n  user-select: text;\n  -webkit-user-select: text;\n}',
    to: '#stage [contenteditable] {\n  user-select: none;\n  -webkit-user-select: none;\n}',
    expect: 'Real content lost its selectability',
  },
  {
    name: 'the running state stops freezing under reduced motion',
    /* The first draft injected a higher-priority animation instead — a new surface escaping the
       floor, which is the shape this repo actually fears. It is a no-op here: the blanket
       `[data-motion="reduce"] *` rule only caps duration and iteration count, and the thing
       that produces `animation-name: none` is this specific rule, at (0,4,0). An injected
       `[data-motion="reduce"] .story-agent-a { … !important }` is (0,2,0) and loses to it. So
       the contract lives here, and this is the edit that removes it. */
    why: 'DESIGN_LANGUAGE §10. The running screen is the one place motion carries meaning, so it is the one place the static fallback has to hold.',
    from: '[data-motion="reduce"] .node.has-task.st-running,\n[data-motion="reduce"] .node.has-task.st-starting {\n  animation: none !important;\n  border-width: 2px;',
    to: '[data-motion="reduce"] .node.has-task.st-running,\n[data-motion="reduce"] .node.has-task.st-starting {',
    expect: 'Reduced-motion running state lost its static blue treatment',
  },
  {
    name: 'the narrow layout goes back to scaling the desktop stage',
    /* Not via `fit()`. Its `stage.style.transform = 'none'` in the narrow branch is belt to the
       CSS braces: the narrow `#stage` rule carries `transform: none !important`, which outranks
       any inline value, so mutating the JS line changes the file and nothing on screen. The
       contract is held in CSS; break it there. */
    why: 'TNG-173: a 1600 px stage scaled into a 390 px viewport is a shrunken screenshot, not a narrow layout — every target goes sub-44 px and the answer text stops being readable.',
    from: '  #stage {\n    width: 100%;\n    height: 100%;\n    transform: none !important;',
    to: '  #stage {\n    width: 100%;\n    height: 100%;\n    transform: scale(0.45) !important;',
    expect: 'narrow mode still scales the stage',
  },
  {
    name: 'the one narrow view control is pushed off the right edge',
    why: "The narrow cluster keeps exactly one control, and the rule's own comment names this failure — anything else in the box pushes the toggle past the viewport. Off-screen is not the same as absent, and only a measured `right` catches it.",
    from: '    left: calc(100vw - 56px);',
    to: '    left: calc(100vw - 8px);',
    expect: 'narrow theme control is not visible/reachable',
  },
  {
    name: 'the narrow touch minimum drops to the desktop hit box',
    /* Two places, and either one alone holds: the blanket floor is what actually produces 44,
       and `#viewctl .iconbtn` restates it. Mutating only the restatement leaves `min-height`
       winning over the smaller `height`, so the measurement never moves. */
    why: 'DESIGN_LANGUAGE §16: 44 px is the touch floor. A 32 px control is the desktop hit box shipped to a thumb, and the narrow cluster has no second target to fall back to.',
    edits: [
      { from: '  .btn, .iconbtn, .filt, .seg button { min-height: 44px; }',
        to: '  .btn, .iconbtn, .filt, .seg button { min-height: 32px; }' },
      { from: '  #viewctl .iconbtn { width: 44px; height: 44px; }',
        to: '  #viewctl .iconbtn { width: 32px; height: 32px; }' },
    ],
    expect: 'narrow theme control is not visible/reachable',
  },
  {
    name: 'replay stops being labelled as replay',
    why: 'ADR 0005: a replay never re-executes. An unlabelled one is indistinguishable from a live run, which is the single most expensive confusion this surface can cause.',
    from: "  wiring.live = 'replay';",
    to: "  wiring.live = 'live';",
    expect: 'Replay is not inert/labelled',
  },
  {
    name: 'an invalid connection is refused without explaining itself',
    why: 'The wiring contract is that a refusal is non-destructive *and* explained. A bare "not allowed" leaves the operator re-trying the same edge, and a check that only counts edges cannot tell the two apart.',
    from: 'function explainInvalid(a, b, ignoreId) {\n  if (a.id === b.id) return',
    to: "function explainInvalid(a, b, ignoreId) {\n  return 'Not allowed.';\n  if (a.id === b.id) return",
    expect: 'Refusal explanation missing',
  },
  {
    name: 'the prompt origin becomes deletable',
    why: 'Delete is one keystroke from a selected node. A graph whose origin can be removed has no provenance root left to read the run from, and nothing on screen says why it went.',
    from: "  if (n.kind === 'prompt' || n.kind === 'response') {",
    to: "  if (n.kind === 'response') {",
    expect: 'Prompt origin was removed or refusal was missing',
  },
  {
    name: 'the single-file artifact reaches the network',
    why: 'The board opens this file from disk with no server. One remote reference and the screen they review is a different screen from the one anyone else sees — and on a plane it is a broken one.',
    from: '</body>',
    to: '<img src="https://loomwatch.invalid/defeat.png" alt="" width="1" height="1">\n</body>',
    expect: 'Standalone attempted a network request',
  },
]

const only = (() => {
  const flag = process.argv.indexOf('--only')
  if (flag === -1) return null
  return new Set(process.argv[flag + 1].split(',').map((n) => Number(n.trim())))
})()
const control = !process.argv.includes('--no-control')

mkdirSync(scratch, { recursive: true })

/* Run the gate on a copied pair and return its combined output plus whether it passed. */
function runGate(dir, html) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'prototype-standalone.html'), html)
  copyFileSync(gate, join(dir, 'verify-prototype.mjs'))
  try {
    const stdout = execFileSync(process.execPath, [join(dir, 'verify-prototype.mjs')], {
      encoding: 'utf8',
      /* capture stderr rather than letting it default through to ours — the gate's failure is
         a thrown stack, and fourteen of them interleaved with the verdicts is unreadable */
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PAPERCLIP_RUN_SCRATCH_DIR: dir },
    })
    return { green: true, report: stdout }
  } catch (err) {
    // The gate throws on its first failed assertion, so a non-zero exit is the point.
    return { green: false, report: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/* The first `Error: …` line is the assertion that stopped the run. Everything after it is the
   stack, and the interpolated JSON state can run to several lines, so take the first line of
   the message and leave the rest out of the comparison. */
function failureMessage(report) {
  const hit = report.match(/^(?:.*?Error:\s*)(.*)$/m)
  return hit ? hit[1].trim() : ''
}

let broken = 0
let ran = 0

if (control && !only) {
  const { green, report } = runGate(join(scratch, 'control'), source)
  if (green) {
    console.log('CONTROL     0. unmutated copy — the gate passes on a copied pair')
  } else {
    console.log('CONTROL FAILED  the gate goes red on an *unmutated* copy, so every red below')
    console.log(`                is unattributable: ${failureMessage(report) || report.trim().slice(-300)}`)
    process.exit(2)
  }
}

for (const [index, mutation] of mutations.entries()) {
  const number = index + 1
  if (only && !only.has(number)) continue
  ran += 1

  const edits = mutation.edits ?? [{ from: mutation.from, to: mutation.to }]
  let mutated = source
  for (const edit of edits) {
    const found = mutated.split(edit.from).length - 1
    if (found !== (edit.count ?? 1)) {
      console.log(`HARNESS ERROR  ${number}. ${mutation.name}`)
      console.log(`               anchor appears ${found}×, expected ${edit.count ?? 1}× — the edit`)
      console.log('               would change nothing and then read as an uncaught defect.')
      process.exit(2)
    }
    mutated = mutated.split(edit.from).join(edit.to)
  }

  const { green, report } = runGate(join(scratch, `m${number}`), mutated)
  const message = failureMessage(report)

  if (green) {
    broken += 1
    console.log(`NOT CAUGHT  ${number}. ${mutation.name}`)
    console.log(`            ${mutation.why}`)
    console.log(`            the gate passed with the defect in place; "${mutation.expect}" is decorative.`)
  } else if (message.includes(mutation.expect)) {
    console.log(`DEFEATED    ${number}. ${mutation.name}`)
    console.log(`            red: ${message.slice(0, 150)}`)
  } else {
    /* Red, but not here. The gate stops at its first failure, so an earlier contract going
       red means the target assertion never ran — which is no evidence about the target. */
    broken += 1
    console.log(`WRONG CONTRACT  ${number}. ${mutation.name}`)
    console.log(`            wanted: ${mutation.expect}`)
    console.log(`            got:    ${message.slice(0, 150) || '(no assertion message — the gate crashed)'}`)
  }
}

console.log()
if (broken === 0) {
  console.log(`${ran}/${ran} mutations produced the failure verify-prototype.mjs promises`
    + `${control && !only ? ', against a control copy that passes' : ''}.`)
  process.exit(0)
}
console.log(`${ran - broken}/${ran} mutations caught — ${broken} did not redden the contract that claims to catch them.`)
process.exit(1)
