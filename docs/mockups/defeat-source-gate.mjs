/* TNG-208 — the shared runner behind the three source-gate counterfactuals.
 *
 * `verify-response-states.mjs`, `verify-a11y-conformance.mjs` and `verify-narrow-conformance.mjs`
 * are the last of the eight TNG-89/TNG-90 gates with no counterfactual. All three read the
 * working-tree `ui/` sources, all three print N/N, and all three have only ever been green —
 * which is the state TNG-203 and TNG-205 were both in while blind.
 *
 * The three harnesses that import this differ only in their inputs and their mutation tables.
 * The method is `defeat-prototype.mjs`'s, adapted from one pinned artifact to a set of source
 * files:
 *
 *   - Run 0 is an unmutated copy and has to come out green. A red control makes every red below
 *     it unattributable, so that case exits 2 instead of reporting a score.
 *   - Three verdicts. DEFEATED is red on exactly the targeted contract. NOT CAUGHT is green with
 *     the defect in place — the contract is decorative. WRONG CONTRACT is red somewhere else
 *     (or red in more places than the mutation targets), which is no evidence about the target
 *     and counts as a failure.
 *   - A mutation whose anchor does not appear the expected number of times is a HARNESS error
 *     that exits 2, not a caught defect: an edit that silently no-ops reads exactly like an
 *     uncaught regression.
 *
 * Nothing under `ui/` is ever written. Each run stages a throwaway tree holding a copy of the
 * gate at `docs/mockups/` and copies of just the files it reads, so the gate's own
 * `new URL('../../<path>', import.meta.url)` resolution lands inside the scratch copy and the
 * working tree is read-only throughout.
 *
 * One verdict has no equivalent in the artifact harness: a gate that exits 2 on a mutated tree
 * has lost its own anchor. That is reported as ANCHOR LOST and counted as a failure. It is not a
 * caught defect — a reviewer running such a gate is told to re-anchor a probe, not that the
 * implementation is non-conformant — and it means either the mutation is testing the anchor
 * rather than the contract, or the gate turns a real regression into gate rot.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** The `PASS`/`FAIL  <id>  …` lines these three gates print, as a set of the failing ids. */
function scoreboard(report) {
  const rows = [...report.matchAll(/^(PASS|FAIL)\s+(\S+)\s/gm)]
  return {
    seen: rows.map((row) => row[2]),
    failing: rows.filter((row) => row[1] === 'FAIL').map((row) => row[2]),
  }
}

function setsEqual(a, b) {
  return a.length === b.length && a.every((entry) => b.includes(entry))
}

/**
 * @param {object} options
 * @param {string} options.gate      repo-relative path to the gate under test
 * @param {string[]} options.inputs  repo-relative paths the gate reads
 * @param {object[]} options.mutations
 */
export function sweep({ gate, inputs, mutations }) {
  const label = gate.replace(/^.*\//, '').replace(/^verify-|\.mjs$/g, '')
  const scratch = join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), `defeat-${label}`)
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })

  const source = new Map()
  for (const rel of inputs) {
    try {
      source.set(rel, readFileSync(join(REPO, rel), 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      console.error(`CANNOT RUN — the gate's input is missing: ${rel}`)
      console.error('This harness measures the shipped implementation, so it needs a full repo checkout.')
      process.exit(2)
    }
  }

  /* Stage a tree the gate can resolve `../../<path>` inside, run it, and report what it scored.
     `LOOMWATCH_ROOT` is cleared because verify-response-states.mjs honours it — inheriting one
     from the caller's environment would silently measure the working tree instead of the copy. */
  function runGate(dir, files) {
    const gateTarget = join(dir, gate)
    mkdirSync(dirname(gateTarget), { recursive: true })
    copyFileSync(join(REPO, gate), gateTarget)
    for (const [rel, text] of files) {
      const target = join(dir, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
    }
    const env = { ...process.env, PAPERCLIP_RUN_SCRATCH_DIR: dir }
    delete env.LOOMWATCH_ROOT
    try {
      const stdout = execFileSync(process.execPath, [gateTarget], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
      return { code: 0, report: stdout }
    } catch (err) {
      return { code: err.status ?? 1, report: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  const only = (() => {
    const flag = process.argv.indexOf('--only')
    if (flag === -1) return null
    return new Set(process.argv[flag + 1].split(',').map((n) => Number(n.trim())))
  })()
  const control = !process.argv.includes('--no-control')

  if (control && !only) {
    const { code, report } = runGate(join(scratch, 'control'), source)
    const { seen, failing } = scoreboard(report)
    if (code === 0 && failing.length === 0 && seen.length > 0) {
      console.log(`CONTROL     0. unmutated copy — ${seen.length}/${seen.length} on a staged copy (${seen.join(' ')})`)
    } else {
      console.log('CONTROL FAILED  the gate does not come out green on an *unmutated* copy, so every')
      console.log('                red below it is unattributable. Fix the staging, not the gate:')
      console.log(report.trim().split('\n').map((line) => `                ${line}`).join('\n'))
      process.exit(2)
    }
  }

  let broken = 0
  let ran = 0

  for (const [index, mutation] of mutations.entries()) {
    const number = index + 1
    if (only && !only.has(number)) continue
    ran += 1

    const files = new Map(source)
    for (const edit of mutation.edits) {
      const before = files.get(edit.file)
      if (before === undefined) {
        console.log(`HARNESS ERROR  ${number}. ${mutation.name}`)
        console.log(`               ${edit.file} is not one of this gate's inputs.`)
        process.exit(2)
      }
      const found = before.split(edit.from).length - 1
      if (found !== (edit.count ?? 1)) {
        console.log(`HARNESS ERROR  ${number}. ${mutation.name}`)
        console.log(`               anchor appears ${found}×, expected ${edit.count ?? 1}× in ${edit.file} —`)
        console.log('               the edit would change nothing and then read as an uncaught defect.')
        process.exit(2)
      }
      files.set(edit.file, before.split(edit.from).join(edit.to))
    }

    const expect = Array.isArray(mutation.expect) ? mutation.expect : [mutation.expect]
    const { code, report } = runGate(join(scratch, `m${number}`), files)
    const { seen, failing } = scoreboard(report)

    if (seen.length === 0 && code !== 2) {
      /* No scoreboard at all. A gate that threw before reporting is not a gate that passed, and
         without this it would land in NOT CAUGHT below and read as a blind contract. */
      broken += 1
      console.log(`GATE CRASHED  ${number}. ${mutation.name}`)
      console.log(`            ${report.trim().split('\n').slice(0, 3).join(' / ').slice(0, 240)}`)
    } else if (code === 2) {
      broken += 1
      const lost = report.match(/^(ANCHOR LOST|CANNOT RUN)[^\n]*/m)
      console.log(`ANCHOR LOST ${number}. ${mutation.name}`)
      console.log(`            ${mutation.why}`)
      console.log(`            the gate could not answer: ${lost ? lost[0] : report.trim().slice(0, 200)}`)
      console.log(`            "${expect.join(', ')}" reads as gate rot, not as a conformance failure.`)
    } else if (failing.length === 0) {
      broken += 1
      console.log(`NOT CAUGHT  ${number}. ${mutation.name}`)
      console.log(`            ${mutation.why}`)
      console.log(`            the gate passed with the defect in place; "${expect.join(', ')}" is decorative.`)
    } else if (setsEqual(failing, expect)) {
      console.log(`DEFEATED    ${number}. ${mutation.name}`)
      console.log(`            red: ${failing.join(', ')}`)
    } else {
      /* Red, but not where the mutation aimed. Either the target survived and something else
         broke, or the target went red alongside a contract that is scoring its work. Neither
         is evidence that the targeted contract can fail on its own. */
      broken += 1
      console.log(`WRONG CONTRACT  ${number}. ${mutation.name}`)
      console.log(`            wanted red: ${expect.join(', ')}`)
      console.log(`            got red:    ${failing.join(', ')}`)
    }
  }

  console.log()
  if (broken === 0) {
    console.log(`${ran}/${ran} mutations reddened exactly the contract that claims to catch them`
      + `${control && !only ? ', against a control copy that passes' : ''}.`)
    process.exit(0)
  }
  console.log(`${ran - broken}/${ran} mutations caught — ${broken} did not redden the contract that claims to catch them.`)
  process.exit(1)
}
