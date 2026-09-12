#!/usr/bin/env node
/* TNG-90 — the counterfactual pass for verify-tng90-states.mjs.
 *
 * verify-tng90-states.mjs is one of exactly two gates that read the artifact the board is
 * being asked to approve. It has only ever printed `47 passed, 0 failed`. A gate that has
 * only ever been green is not evidence of anything: it is equally consistent with "the
 * artifact holds thirteen states" and "the probe stopped looking". Two gates in this repo
 * have already gone blind while staying green (TNG-203, TNG-205), and the load-bearing one
 * had no counterfactual at all.
 *
 * So this reproduces, one at a time, the defects verify-tng90-states.mjs claims to catch —
 * each one a regression the design record actually argues against — and requires the named
 * checks to go red. A mutation that lands and leaves the gate green means that contract is
 * decorative, and this exits non-zero.
 *
 *   node docs/mockups/defeat-tng90-states.mjs
 *   node docs/mockups/defeat-tng90-states.mjs --only 1,7     # a subset, by number
 *
 * The pinned artifact is never touched. Each mutation is applied to a *copy*, in a scratch
 * directory alongside a copy of the gate — the gate resolves its artifact relative to its
 * own file, so a copied pair measures the mutant with the shipped probe, byte for byte, and
 * `docs/mockups/prototype-standalone.html` keeps its `a339e26a…` hash throughout.
 *
 * A mutation whose anchor does not appear the expected number of times is a *harness* error,
 * not a caught defect: a replacement that silently no-ops changes nothing and then reads as
 * an uncaught regression. That case exits 2 and says so.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const gate = join(here, 'verify-tng90-states.mjs')
const artifact = join(here, 'prototype-standalone.html')
const scratch = join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'defeat-tng90')

const source = readFileSync(artifact, 'utf8')

/* Each entry: the regression, the edit that reproduces it, and the checks that must go red.
   `expect` is a minimum — a mutation usually reddens more than its own contract, and extra
   reds are reported but not required, so the list stays about the contract under test. */
const mutations = [
  {
    name: 'TNG-166 verbatim — the thirteenth state reports the crash code again',
    why: 'The `#unanswered` screen exists because the implementation labelled a clean run with no answer `process_crashed`. If the gate cannot see that code come back, the screen is decoration.',
    from: '<span class="wm">missing_canonical_response</span>',
    to: '<span class="wm">process_crashed</span>',
    expect: [
      'no answer — the run reports missing_canonical_response',
      'no answer — it is NOT reported as a crash (counterfactual)',
      'no answer — the plain-language second line is present and additive',
    ],
  },
  {
    name: 'the document chip stops switching — every state reads clean',
    why: 'TNG89_INTERACTION §9.1 makes the chip the document\'s state surface. A chip frozen on `clean` is the failure that silently runs unsaved bytes.',
    from: "  dirty:      { l1: 'research-team.yaml', l2: '3 lines differ', action: 'primary:Save ⌘S',",
    to: "  dirty:      { l1: 'research-team.yaml', l2: '~/.loomwatch/teams', action: '',",
    expect: [
      'dirty — chip reports a magnitude, not a state word',
      'dirty — offers the write, and clean does not (counterfactual)',
      'composer — the run screen is reached with a dirty document',
    ],
  },
  {
    name: 'the dirty composer degrades to a bare Run',
    why: '§1.4: there is no run-without-saving, because a run executes an exact revision. A bare `Run` on a dirty document is the whole contract lost.',
    /* Mutate the render, not `COMPOSER.dirty.act`. The screen router calls `renderComposer()`
       and then `paintRun()`, and `paintRun()` rewrites `#compAct` from its own `dirtyIdle`
       branch — so on the seeded `compose` screen the table entry never reaches the DOM, and
       editing it changes the file without changing the screen. README.md already records
       that dead entry as how `dirty / Save & run` shipped missing in the first place. */
    from: '            ? `<button class="btn btn-primary" onclick="saveAndRun()">Save &amp; run &nbsp;⌘⇧↵</button>`',
    to: '            ? `<button class="btn btn-primary" onclick="submitRun()">Run &nbsp;⌘↵</button>`',
    expect: ['dirty/Save & run — dirty composer offers Save & run, not a bare Run'],
  },
  {
    name: 'expanding a category opens a different one',
    why: 'The one-hop rule is a claim about what expansion does. A probe that only counts open categories cannot tell "opened tools" from "opened something".',
    from: '  run.open = run.open === c ? null : c;',
    to: "  run.open = run.open === c ? null : 'agents';",
    expect: [
      'one hop at a time — expanding a category opens that one and no other',
      'one hop at a time — the opened hop names the edge kind it expanded along',
    ],
  },
  {
    name: "a provenance category is dropped — five of the contract's six",
    why: 'CONTRACT §12 fixes the six. A summary that quietly shows five under-reports what the run touched, which is the one direction provenance must never fail in.',
    from: "  ['commands',  'command',   '3',  'partial'],\n  ['sources',   'source',    '5',  'partial']\n];",
    to: "  ['commands',  'command',   '3',  'partial']\n];",
    expect: [
      'provenance summary — all six contract categories present',
      'one hop at a time — the six categories survive the expansion',
      'no answer — a run without an answer still reports its provenance',
    ],
  },
  {
    name: 'the categories reorder themselves by count',
    why: 'Fixed order is the requirement, not the set: the operator learns positions, and a graph that re-sorts itself by count is unlearnable. A set-membership check would pass this.',
    from: "  ['agents',    'agent',     '2',  'complete'],\n"
      + "  ['reasoning', 'reasoning', '7',  'partial'],\n"
      + "  ['skills',    'skill',     '1',  'complete'],\n"
      + "  ['tools',     'tool',      '11', 'partial'],\n"
      + "  ['commands',  'command',   '3',  'partial'],\n"
      + "  ['sources',   'source',    '5',  'partial']",
    to: "  ['tools',     'tool',      '11', 'partial'],\n"
      + "  ['reasoning', 'reasoning', '7',  'partial'],\n"
      + "  ['sources',   'source',    '5',  'partial'],\n"
      + "  ['commands',  'command',   '3',  'partial'],\n"
      + "  ['agents',    'agent',     '2',  'complete'],\n"
      + "  ['skills',    'skill',     '1',  'complete']",
    expect: ['provenance summary — categories hold the contract order'],
  },
  {
    name: 'redacted evidence grows a way through',
    why: 'ADR 0005 §7 fails closed: redaction is a property of the capture, not a locked door with a key behind it. A reveal affordance is the design defect, and it arrives as a label.',
    from: "  redacted:    { word: 'Redacted',",
    to: "  redacted:    { word: 'Redacted · Reveal bytes',",
    expect: ['redaction — no hover-to-reveal or request-access affordance on a visible redacted card'],
  },
  {
    name: 'the transport gap strip is dropped from the live screen',
    why: 'CONTRACT §3.2: a reconnect must be visible and must not be read as pause/cancel. Dropping the strip makes a stalled stream look like a healthy one.',
    from: '    ${run.gap ? `<div class="rt-strip halt t-meta">',
    to: '    ${false ? `<div class="rt-strip halt t-meta">',
    expect: [
      'reconnect — live screen carries a visible transport gap strip',
      'reconnect — the gap names its watermark rather than saying only "reconnecting"',
    ],
  },
  {
    name: 'the dark theme carries the light ground',
    why: 'The TNG-90 screens are new surfaces; a hardcoded value that only resolves in one theme is the standing risk, and it shows up as both themes agreeing.',
    from: '[data-theme="dark"] {\n  --color-ground:         var(--lw-obsidian-950); /* #08080A                  */',
    to: '[data-theme="dark"] {\n  --color-ground:         var(--lw-paper-50); /* #08080A                  */',
    expect: ['themes — dark and light resolve to different grounds on the trace screen'],
  },
  {
    name: 'a new surface ships an infinite animation reduced motion does not cover',
    /* The blanket `*, *::before, *::after { animation-iteration-count: 1 !important }` is the
       repo's reduced-motion floor. A class selector carrying `!important` outranks it, which
       is exactly how a new surface slips past a floor that looks total. */
    why: 'DESIGN_LANGUAGE §10. The live screen is the one place motion carries meaning, so it is the one place a static fallback has to hold.',
    from: '</style>',
    to: '@keyframes lw-defeat-pulse { from { opacity: 1 } to { opacity: .55 } }\n'
      + '.rt-response { animation: lw-defeat-pulse 2s linear infinite !important; }\n</style>',
    expect: ['reduced motion — no infinite animation survives on the live screen'],
  },
  {
    name: 'the hidden specimen gallery ships visible',
    why: 'This is the blindness the gate was rewritten to escape: a DOM-wide `.cap-*` count read 2/2/2/2 on every screen, including `team`, which has no evidence on it at all. The counterfactual is the only thing standing between that count and a green run.',
    /* Two dead ends before this one, both of which read as an uncaught defect rather than as
       a mutation that did nothing:
         - deleting the `hidden` attribute from the markup lasts until the first paint, because
           the screen router re-sets `hidden` on every panel it is not showing;
         - relaxing `.board[hidden] { display: none }` loses the cascade to the blanket
           `[hidden] { display: none !important }` the prototype carries for its id-level rules.
       So un-hide the board that actually holds the specimens — `#system`, whose `#capRow` and
       `#capGrey` carry two copies of all four capture states — at a specificity that wins. */
    from: '</style>',
    to: '#system[hidden] { display: block !important; }\n</style>',
    expect: ['capture gap — a screen with no evidence shows no capture cards (counterfactual)'],
  },
  {
    name: 'unavailable evidence stops stating a reason',
    why: '"Not captured" without a reason sends the operator looking for a gap that has already been explained. §8 promises the reason is on the card.',
    from: "    ${e.why ? `<span class=\"e-sub t-meta\">${e.why}</span>` : ''}",
    to: "    ${false ? `<span class=\"e-sub t-meta\">${e.why}</span>` : ''}",
    count: 2,
    expect: ['capture gap — unavailable evidence states a reason'],
  },
]

const only = (() => {
  const flag = process.argv.indexOf('--only')
  if (flag === -1) return null
  return new Set(process.argv[flag + 1].split(',').map((n) => Number(n.trim())))
})()

mkdirSync(scratch, { recursive: true })

let broken = 0
let ran = 0
for (const [index, mutation] of mutations.entries()) {
  const number = index + 1
  if (only && !only.has(number)) continue
  ran += 1

  const want = mutation.count ?? 1
  const found = source.split(mutation.from).length - 1
  if (found !== want) {
    console.log(`HARNESS ERROR  ${number}. ${mutation.name}`)
    console.log(`               anchor appears ${found}×, expected ${want}× — the edit would`)
    console.log('               change nothing and then read as an uncaught defect.')
    process.exit(2)
  }

  const dir = join(scratch, `m${number}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'prototype-standalone.html'), source.split(mutation.from).join(mutation.to))
  copyFileSync(gate, join(dir, 'verify-tng90-states.mjs'))

  let report
  try {
    report = execFileSync(process.execPath, [join(dir, 'verify-tng90-states.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, PAPERCLIP_RUN_SCRATCH_DIR: dir },
    })
  } catch (err) {
    // The gate exits 1 precisely because it reported failures — which is the point.
    report = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }

  /* A contract counts as defeated when its own line went red, not merely when the run did.
     Match by prefix rather than by splitting the line on its detail separator: the gate
     writes `FAIL <label> — <detail>`, and most labels contain that same ` — ` themselves, so
     splitting on it yields "no answer" and nothing ever matches. The first draft of this file
     did exactly that and reported 0/12 against a gate that had gone red eleven times. */
  const red = [...report.matchAll(/^\s*FAIL\s+(.*)$/gm)].map((hit) => hit[1].trimEnd())
  const hit = (label) => red.some((line) => line === label || line.startsWith(`${label} — `))
  const missed = mutation.expect.filter((label) => !hit(label))
  const extra = red.filter((line) => !mutation.expect.some(
    (label) => line === label || line.startsWith(`${label} — `)))

  if (missed.length === 0) {
    console.log(`DEFEATED    ${number}. ${mutation.name}`)
    console.log(`            red: ${mutation.expect.join(' | ')}`)
    if (extra.length) console.log(`            also red: ${extra.join(' | ')}`)
  } else {
    broken += 1
    console.log(`NOT CAUGHT  ${number}. ${mutation.name}`)
    console.log(`            ${mutation.why}`)
    console.log(`            stayed green: ${missed.join(' | ')}`)
    console.log(`            gate said: ${report.trim().split('\n').slice(-3).join(' / ')}`)
  }
}

console.log()
if (broken === 0) {
  console.log(`${ran}/${ran} mutations produced the failure verify-tng90-states.mjs promises.`)
  process.exit(0)
}
console.log(`${ran - broken}/${ran} mutations caught — ${broken} slipped past a contract that claims to catch them.`)
process.exit(1)
