#!/usr/bin/env node
// TNG-203 — the fixture `webkit-probe-short-viewport.js` measures.
//
// verify-short-viewport.mjs reads the stylesheet as text. That discipline is what let TNG-201
// through in the first place: a grep for "does the §13 height rule exist" scored a rule that
// set `display: none` on the prompt textarea and the run action as a pass. The static gate now
// asserts the *absence* of those declarations, which is better — but it is still a grep, and a
// grep cannot see the cascade. `.comp-mid` could be un-hidden here and re-hidden by a later,
// more specific rule; the composer could be pushed off-viewport by `bottom`; `visibility` and
// `height: 0` are not `display: none`. Every one of those renders as "no way to prompt" and
// every one of them passes the static gate.
//
// So this puts the shipped CSS bundle in front of a real engine at 1280 × 599 and asks the
// only question that matters: can the operator see the input and the button.
//
//   cd ui && npm run build          # the bundle this reads is the built one, not the source
//   node docs/mockups/build-short-viewport-fixture.mjs
//   swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
//   /tmp/verify-webkit /tmp/loomwatch-short/host.html --eval-async docs/mockups/webkit-probe-short-viewport.js
//
// Same two constraints as build-narrow-fixture.mjs, and they are load-bearing here too:
//
//   - verify-webkit.swift's window is 1600 × 1000, so `(max-height: 599px)` would never match.
//     An iframe carries its own viewport, so the probe measures inside one sized 1280 × 599.
//   - A file:// iframe is cross-origin in WebKit and `contentDocument` throws, so the CSS and
//     markup travel in a JSON island the probe writes into an about:blank iframe.
//
// ONE fixture-only liberty, declared because it changes what the probe proves: both popovers
// are rendered in their OPEN state. The real Workspace mounts `.mode-pop` only while
// `modeOpen` is true, so an unopened popover is absent from the DOM for a reason that has
// nothing to do with §13. Rendering them open reproduces the state the TNG-203 defect lives
// in — the operator pressed the chip, `modeOpen` went true, and CSS painted nothing — which
// is the only state in which "advertises a dialog that never appears" is observable.
// `data-popover` is likewise fixture wiring: it names the dialog each `aria-haspopup` control
// opens, a mapping that lives in React state rather than in the DOM.

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

// The shapes the §13 height rule acts on, in the markup Composer.tsx and ViewControls.tsx
// render. Class lists and ARIA are copied from those files verbatim — classes are what the
// cascade sees, and `aria-haspopup` is the attribute that makes a hidden popover a *dead
// affordance* rather than merely an absent panel.
//
// `.lw-outline` is deliberately absent: it has a rule in runtime.css but no component renders
// it anywhere in the shipped bundle, so measuring it would invent a surface the product does
// not have.
const body = `
  <div class="panel bottom cx e1 lw-composer" role="group" aria-label="Prompt composer">
    <button type="button" class="mode-chip t-body-m team" id="chip"
            aria-haspopup="dialog" aria-expanded="true" data-popover="modepop"
            title="How this team will execute">
      <span class="glyph" aria-hidden="true">*</span>
      <span class="label">Team &middot; self-organizing</span>
    </button>
    <div class="comp-mid">
      <textarea id="prompt" rows="1" aria-label="What should the team do?"
                placeholder="What should the team do?"></textarea>
      <span class="comp-note t-meta">Saves team.yaml first, then runs that exact revision.</span>
    </div>
    <div class="comp-act">
      <button type="button" class="btn btn-primary" id="run">Save &amp; run <kbd>&#8984;&#8629;</kbd></button>
      <button type="button" class="iconbtn" id="history"
              aria-haspopup="dialog" aria-expanded="true" data-popover="historypop"
              aria-label="Run history">H</button>
    </div>
  </div>

  <div class="panel right bottom e1 lw-viewctl" id="viewctl" aria-label="View controls" role="toolbar">
    <button type="button" class="iconbtn" aria-label="Zoom out">&minus;</button>
    <span class="zoomlvl t-mono-sm">100%</span>
    <button type="button" class="iconbtn" aria-label="Zoom in">+</button>
    <button type="button" class="iconbtn" aria-label="Fit view">&#9974;</button>
    <button type="button" class="iconbtn" aria-label="Switch to light theme">&#9790;</button>
  </div>

  <div class="pop e2 mode-pop" id="modepop" role="dialog" aria-label="What this mode means">
    <div class="mp-body t-body">
      <p><code>edges</code> is empty, so <b>Collector</b> receives the goal and decides who else to involve.</p>
      <p class="mp-tools t-meta">roster &middot; dispatch &middot; ask &middot; handoff &middot; report &middot; escalate</p>
    </div>
    <div class="pop-sep"></div>
    <div class="mp-guards">
      <span class="mp-head t-micro">Guards</span>
      <label class="mp-field t-meta">Max dispatch depth <input type="number" value="8" aria-label="Max dispatch depth" /></label>
      <label class="mp-field t-meta">Max concurrent dispatches <input type="number" value="8" aria-label="Max concurrent dispatches" /></label>
      <label class="mp-field t-meta">Team budget (USD) <input type="number" placeholder="No limit" aria-label="Team budget limit in USD" /></label>
      <span class="mp-note t-meta">Budgets are admission thresholds, not interruptions.</span>
    </div>
  </div>

  <div class="pop e2 lw-history" id="historypop" role="dialog" aria-label="Run history">
    <div class="pop-list">
      <button class="pop-row"><span class="hrow-text"><span class="goal">Summarise yesterday's incidents</span><span class="sub">completed</span></span><span class="when">2h</span></button>
      <button class="pop-row"><span class="hrow-text"><span class="goal">Draft the release note</span><span class="sub">failed</span></span><span class="when">1d</span></button>
    </div>
  </div>
`

const out = process.env.LOOMWATCH_SHORT_FIXTURE ?? '/tmp/loomwatch-short'
mkdirSync(out, { recursive: true })
writeFileSync(
  join(out, 'host.html'),
  `<!doctype html><html><body style="margin:0">\n<script id="fixture" type="application/json">${JSON.stringify({ css, body })}</script>\n</body></html>\n`,
)
console.log(`Wrote ${join(out, 'host.html')} from ${bundle[0]} (${css.length} bytes of CSS).`)
