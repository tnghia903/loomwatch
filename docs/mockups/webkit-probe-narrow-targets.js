// TNG-173 / §11.6 failure 21 — the rendered confirmation of the 44 px contract.
//
// verify-narrow-conformance.mjs N3 reads declared heights and names specificity as the thing
// it cannot see. This measures `getBoundingClientRect().height` in WebKit against the shipped
// CSS bundle, so a 44 px rule that loses the cascade is caught here even though N3 passes.
//
// Build the fixture first (see build-narrow-fixture.mjs), then:
//   /tmp/verify-webkit /tmp/loomwatch-narrow/host.html --eval-async docs/mockups/webkit-probe-narrow-targets.js
//
// The harness exits 1 when this output contains `FAIL`.
//
// Proven in both directions: against the fixed bundle every row reads 44.0px; against the
// same bundle with the four narrow rules reverted, the rows read 28 / 32 / 24 / 42px. A probe
// that cannot produce its own failure is not evidence.
(async () => {
  const fixture = JSON.parse(document.getElementById('fixture').textContent)
  // The harness window is 1600 px, so the narrow media queries would never match it. An
  // iframe carries its own viewport. It is written from about:blank rather than loaded from
  // file:// because a file:// iframe is cross-origin in WebKit and `contentDocument` throws.
  const frame = document.createElement('iframe')
  frame.style.cssText = 'width:375px;height:1200px;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write('<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>' + fixture.css + '</style></head><body class="lw-shell run-view">' + fixture.body + '</body></html>')
  doc.close()
  for (let i = 0; i < 60 && !doc.getElementById('run'); i++) await new Promise((resolve) => setTimeout(resolve, 50))

  const win = frame.contentWindow
  const out = [`iframe viewport = ${win.innerWidth}px · narrow rules apply: ${win.matchMedia('(max-width: 767px)').matches}`]
  if (!win.matchMedia('(max-width: 767px)').matches) {
    out.push('FAIL  the iframe is not below 768 px — nothing below measures §11.6')
    return out.join('\n')
  }

  // A selector that no longer matches must not read as a 0 px failure it never observed —
  // the same discipline as verify-narrow-conformance.mjs's ANCHOR LOST.
  const measure = (name, node) => {
    if (!node) { out.push(`FAIL  ${name} — SELECTOR LOST, re-anchor before trusting this result`); return }
    const height = node.getBoundingClientRect().height
    out.push(`${height >= 44 ? 'PASS' : 'FAIL'}  ${name} rendered ${height.toFixed(1)}px`)
  }
  for (const [name, id] of [
    ['composer Run (.btn.btn-primary)', 'run'],
    ['composer Stop (.btn)', 'stop'],
    ['run history (.iconbtn)', 'history'],
    ['theme toggle (.iconbtn)', 'theme'],
    ['Open full provenance (.btn)', 'openprov'],
    ['popover Retry (.pop-inline .btn)', 'popbtn'],
  ]) measure(name, doc.getElementById(id))
  for (const [name, selector] of [
    ['mode chip (.mode-chip)', '.mode-chip'],
    ['filter chip (.filter-chip)', '.filter-chip'],
    ['summary row (.prov-sum)', '.prov-sum'],
  ]) measure(name, doc.querySelector(selector))
  return out.join('\n')
})()
