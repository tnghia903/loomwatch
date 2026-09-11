#!/usr/bin/env node
// TNG-90 §11.6 — the fixture `webkit-probe-prototype-narrow.js` measures.
//
// §11.6 is written about *the prototype*: "Below 768 px the prototype stops fitting the
// entire 1600 x 1000 stage with a transform." TNG-173 closed §11.6's four contracts, but it
// closed them against `ui/` production source — `verify-narrow-conformance.mjs` reads
// `RunColumn.tsx` and the app stylesheets. The Gate B card pins the *prototype*, and until
// this file ran, no gate had ever measured the prototype below 768 px.
//
//   node docs/mockups/build-prototype-narrow-fixture.mjs
//   swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
//   /tmp/verify-webkit <fixture>/host.html --eval-async docs/mockups/webkit-probe-prototype-narrow.js
//
// Same two constraints as build-narrow-fixture.mjs, and for the same reasons:
//
//   - verify-webkit.swift's window is 1600 x 1000, so the narrow media queries would never
//     match it. An iframe carries its own viewport, so the probe measures inside one at 375 px.
//   - A file:// iframe is cross-origin in WebKit and `contentDocument` throws. So the whole
//     standalone travels in a JSON island and the probe writes it into an about:blank
//     iframe, which stays same-origin and still executes the prototype's inline scripts.
//
// The artifact read here is the pinned one. Its hash is printed so a reviewer can confirm
// the bytes measured are the bytes the Gate B card names.

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const artifact = join(repo, 'docs/mockups/prototype-standalone.html')

let html
try {
  html = readFileSync(artifact, 'utf8')
} catch {
  console.error(`No artifact at ${artifact} — run build-standalone.mjs first.`)
  process.exit(2)
}

// The standalone must be self-contained for the iframe to be a fair specimen: an external
// <link>/<script> would resolve against about:blank and silently drop the stylesheet under
// measurement, which would read as a spectacular 0 px failure rather than a missing file.
const external = [...html.matchAll(/<(?:link[^>]+rel=["']?stylesheet|script[^>]+src=)[^>]*>/gi)]
if (external.length) {
  console.error(`Artifact is not self-contained (${external.length} external asset reference):`)
  for (const m of external) console.error(`  ${m[0]}`)
  process.exit(2)
}

const digest = createHash('sha256').update(html).digest('hex')

/* `--defeat <name>` reproduces the pre-fix shape of one contract, so each check can be shown
   to fail against a prototype that violates it. A probe that cannot produce its own failure
   is not evidence — and on this artifact two checks have already shipped green while
   measuring nothing. Every defeat is injected last so it outranks the narrow block on source
   order at equal specificity, and `!important` covers the rest. */
const DEFEATS = {
  // §11.6 failure 21 — the sizes the narrow block lifts, put back.
  targets: '.btn, .iconbtn, .mode-chip, .filt, .seg button { min-height: 0 !important; height: 28px !important; }',
  // §11.6 failure 22 — provenance lost with the canvas, the production defect TNG-173 fixed.
  provenance: '#overlay .activity-ent, #overlay #provTray, #overlay .prov-empty { display: none !important; }',
  // §11.6 failure 21 — theme switching hidden at narrow width.
  theme: '#themeBtn, #themeBtn2 { display: none !important; }',
}

const defeatIdx = argvFlag('--defeat')
let defeat = null
if (defeatIdx != null) {
  defeat = process.argv[defeatIdx + 1]
  if (!Object.hasOwn(DEFEATS, defeat)) {
    console.error(`unknown --defeat "${defeat}" — expected one of: ${Object.keys(DEFEATS).join(', ')}`)
    process.exit(2)
  }
  const style = `<style id="defeat-${defeat}">${DEFEATS[defeat]}</style>`
  if (!html.includes('</head>')) {
    console.error('artifact has no </head> to inject the defeat into')
    process.exit(2)
  }
  html = html.replace('</head>', `${style}</head>`)
}

function argvFlag(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : i
}

// `<` is escaped so the payload cannot terminate the host's <script> element.
const island = JSON.stringify(html).replace(/</g, '\\u003c')

const dir = mkdtempSync(join(tmpdir(), 'loomwatch-proto-narrow-'))
writeFileSync(
  join(dir, 'host.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>prototype narrow fixture</title></head>` +
    `<body><script type="application/json" id="proto">${island}</script></body></html>`,
)

console.log(`fixture:  ${join(dir, 'host.html')}`)
console.log(`artifact: ${artifact}`)
console.log(`sha256:   ${digest}`)
if (defeat) console.log(`defeat:   ${defeat} (counterfactual — the probe MUST fail against this)`)
