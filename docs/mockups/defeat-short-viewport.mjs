#!/usr/bin/env node
// TNG-203 — the counterfactual pass for webkit-probe-short-viewport.js.
//
// A gate that has only ever been green is not evidence. This reproduces the defects the probe
// claims to catch — starting with TNG-201's rule verbatim — and requires the named contracts to
// go red. If a mutation lands and the probe stays green, the contract is decorative and this
// exits non-zero.
//
//   cd ui && npm run build
//   node docs/mockups/build-short-viewport-fixture.mjs
//   swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
//   VERIFY_WEBKIT=/tmp/verify-webkit node docs/mockups/defeat-short-viewport.mjs
//
// Mutations are appended to the built bundle rather than edited into it: a later rule of equal
// specificity wins the cascade, so appending restores the pre-fix behaviour without needing to
// find and delete the fixed one. That also means these never touch `ui/` or any pinned artifact.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const harness = process.env.VERIFY_WEBKIT ?? '/tmp/verify-webkit'
const probe = join(repo, 'docs/mockups/webkit-probe-short-viewport.js')
const assets = join(repo, 'ui/dist/assets')

let bundle
try {
  bundle = readdirSync(assets).filter((name) => name.endsWith('.css'))
} catch {
  console.error(`No build at ${assets} — run \`npm run build\` in ui/ first.`)
  process.exit(2)
}
if (bundle.length !== 1) {
  console.error(`Expected exactly one CSS bundle in ${assets}, found ${bundle.length}.`)
  process.exit(2)
}
const css = readFileSync(join(assets, bundle[0]), 'utf8')

// The fixture body is whatever build-short-viewport-fixture.mjs last wrote, so the two files
// cannot drift into measuring different markup.
const base = process.env.LOOMWATCH_SHORT_FIXTURE ?? '/tmp/loomwatch-short'
let body
try {
  body = JSON.parse(readFileSync(join(base, 'host.html'), 'utf8').match(/<script id="fixture"[^>]*>([\s\S]*?)<\/script>/)[1]).body
} catch {
  console.error(`No fixture at ${base}/host.html — run \`node docs/mockups/build-short-viewport-fixture.mjs\` first.`)
  process.exit(2)
}

const SHORT = (rules) => `\n@media (max-height: 599px) {\n${rules}\n}\n`

const mutations = [
  {
    name: 'TNG-201 verbatim — hide .comp-mid and .comp-act',
    css: SHORT('  .lw-composer .comp-mid, .lw-composer .comp-act { display: none; }'),
    expect: ['R1', 'R2', 'R3'],
  },
  {
    name: 'TNG-201 verbatim — hide the popovers under a chip that still advertises them',
    css: SHORT('  .lw-outline, .mode-pop, .lw-history { display: none; }'),
    expect: ['R4', 'R6'],
  },
  {
    name: 'uncap the mode popover (the "it cannot fit" premise)',
    css: SHORT('  .mode-pop { max-height: none; }'),
    expect: ['R6'],
  },
  {
    name: 're-tighten the popover anchor to inset + 52px (opens the popover through the composer)',
    css: SHORT('  .mode-pop, .lw-history { bottom: calc(var(--lw-panel-inset) + 52px); }'),
    expect: ['R9'],
  },
  {
    name: 'un-merge the view controls back into a second stacked band',
    css: SHORT('  .lib-open .lw-viewctl { bottom: calc(var(--lw-panel-inset) + 68px); }'),
    expect: ['R7'],
  },
  {
    name: 'push the composer off-viewport by `bottom` (invisible to a display:none grep)',
    // `.panel.bottom` is (0,2,0); a bare `.lw-composer` is (0,1,0) and loses the cascade, so
    // the first attempt at this mutation changed nothing and read as an uncaught defect.
    css: SHORT('  .lw-composer.panel.bottom { bottom: -200px; }'),
    expect: ['R5'],
  },
  {
    name: 'fade the run action to opacity 0 (invisible to a display:none grep)',
    css: SHORT('  .lw-composer .comp-act .btn-primary { opacity: 0; }'),
    expect: ['R2'],
  },
  {
    name: 'undercut the 44px target at the short AND narrow intersection',
    css: SHORT('  .lw-composer .comp-act .btn { height: 28px; }'),
    expect: ['R8'],
  },
]

const out = join(base, 'defeat')
mkdirSync(out, { recursive: true })

let broken = 0
for (const [index, mutation] of mutations.entries()) {
  const host = join(out, `host-${index}.html`)
  writeFileSync(
    host,
    `<!doctype html><html><body style="margin:0">\n<script id="fixture" type="application/json">${JSON.stringify({ css: css + mutation.css, body })}</script>\n</body></html>\n`,
  )
  let report
  try {
    report = execFileSync(harness, [host, '--eval-async', probe], { encoding: 'utf8' })
  } catch (err) {
    // The harness exits 1 precisely because the probe reported failures — which is the point.
    report = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  // A contract counts as defeated when its own line went red, not merely when the run did.
  const red = new Set([...report.matchAll(/^FAIL\s+(\w+)/gm)].map((hit) => hit[1]))
  const missed = mutation.expect.filter((id) => !red.has(id))
  if (missed.length === 0) {
    console.log(`DEFEATED  ${mutation.name}`)
    console.log(`          red: ${mutation.expect.join(', ')}`)
  } else {
    broken += 1
    console.log(`NOT CAUGHT  ${mutation.name}`)
    console.log(`            expected red: ${mutation.expect.join(', ')} — stayed green: ${missed.join(', ')}`)
    console.log(report.split('\n').map((line) => `            ${line}`).join('\n'))
  }
}

console.log()
if (broken === 0) {
  console.log(`${mutations.length}/${mutations.length} mutations produced the failure the probe promises.`)
  process.exit(0)
}
console.log(`${mutations.length - broken}/${mutations.length} mutations caught — ${broken} slipped past a contract that claims to catch them.`)
process.exit(1)
