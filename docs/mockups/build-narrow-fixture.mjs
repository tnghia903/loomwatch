#!/usr/bin/env node
// TNG-173 — the fixture `webkit-probe-narrow-targets.js` measures.
//
// §11.6 failure 21 is a *rendered* contract ("a core action smaller than 44 px. Fail."), and
// verify-narrow-conformance.mjs reads DECLARED heights. It says so in its own header: it
// cannot see specificity, so a 44 px rule that loses the cascade to a more specific 32 px
// rule would be scored as a pass. This fixture closes that gap by putting the shipped CSS
// bundle in front of a real engine at 375 px.
//
//   cd ui && npm run build          # the bundle this reads is the built one, not the source
//   node docs/mockups/build-narrow-fixture.mjs
//   swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
//   /tmp/verify-webkit /tmp/loomwatch-narrow/host.html --eval-async docs/mockups/webkit-probe-narrow-targets.js
//
// Two constraints shaped this, and both are load-bearing:
//
//   - verify-webkit.swift's window is 1600 × 1000, so the narrow media queries would never
//     match. An iframe carries its own viewport, so the probe measures inside one at 375 px.
//   - A file:// iframe is cross-origin in WebKit and `contentDocument` throws. So the CSS and
//     markup travel in a JSON island and the probe writes them into an about:blank iframe,
//     which stays same-origin.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const assets = join(repo, 'ui/dist/assets')

let bundle
try {
  bundle = readdirSync(assets).filter((name) => name.endsWith('.css'))
} catch {
  console.error(`No build at ${assets} — run \`npm run build\` in ui/ first.`)
  process.exit(2)
}
if (bundle.length !== 1) {
  console.error(`Expected exactly one CSS bundle in ${assets}, found ${bundle.length}: ${bundle.join(', ')}`)
  process.exit(2)
}
const css = readFileSync(join(assets, bundle[0]), 'utf8')

// The core actions §11.6 failure 21 names, in the markup shapes Workspace/RunColumn render:
// the composer's buttons and mode chip, the run-history and theme `.iconbtn`s, the popover
// `.btn` whose 24 px rule outranks `.btn` on specificity, and the narrow provenance controls
// TNG-173 added. Ids are what the probe measures; classes are what the cascade sees.
const body = `
  <div class="lw-composer">
    <span class="mode-chip"><span class="label">Team</span></span>
    <div class="comp-mid"><textarea rows="1"></textarea></div>
    <div class="comp-act">
      <button class="iconbtn" id="history" aria-label="Run history">H</button>
      <button class="iconbtn" id="theme" aria-label="Switch theme">T</button>
      <button class="btn btn-primary" id="run">Run</button>
      <button class="btn" id="stop">Stop</button>
    </div>
  </div>
  <div class="run-column">
    <section class="run-prov">
      <div class="run-prov-filters"><button class="filter-chip" aria-pressed="true">commands</button></div>
      <ul class="run-prov-sums"><li><button class="prov-sum"><span class="ps-label">commands</span><span class="ps-count">1</span><span class="ps-level">complete</span></button></li></ul>
      <button class="btn" id="openprov">Open full provenance</button>
    </section>
  </div>
  <div class="pop-inline"><button class="btn" id="popbtn">Retry</button></div>
`

const out = process.env.LOOMWATCH_NARROW_FIXTURE ?? '/tmp/loomwatch-narrow'
mkdirSync(out, { recursive: true })
writeFileSync(
  join(out, 'host.html'),
  `<!doctype html><html><body style="margin:0">\n<script id="fixture" type="application/json">${JSON.stringify({ css, body })}</script>\n</body></html>\n`,
)
console.log(`Wrote ${join(out, 'host.html')} from ${bundle[0]} (${css.length} bytes of CSS).`)
