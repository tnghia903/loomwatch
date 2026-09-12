// TNG-203 / CANVAS_SPEC §13 (height) — the rendered confirmation that the short-viewport rule
// clusters chrome instead of deleting the product's primary input.
//
// verify-short-viewport.mjs reads declared `display: none` out of the stylesheet. It cannot see
// the cascade, cannot see `bottom` pushing the composer off-viewport, and cannot tell
// `visibility: hidden` or `height: 0` from a rule that never fired. This measures
// `checkVisibility()` and `getBoundingClientRect()` in WebKit against the shipped CSS bundle.
//
// Build the fixture first (see build-short-viewport-fixture.mjs), then:
//   /tmp/verify-webkit /tmp/loomwatch-short/host.html --eval-async docs/mockups/webkit-probe-short-viewport.js
//
// The harness exits 1 when this output contains `FAIL`.
//
// Every contract is a PAIR: the same assertion at 599 px and at 601 px of height. §13 authorizes
// a *clustering* difference across that boundary and nothing else, so a contract that reads the
// same on both sides is the point, not a redundancy — it is what distinguishes "the rule fired
// and clustered" from "the rule fired and removed the composer". R7 is the one contract required
// to DIFFER, and it is measured where the stacking rule it undoes actually applies.
(async () => {
  const fixture = JSON.parse(document.getElementById('fixture').textContent)
  const out = []

  // An iframe carries its own viewport; the harness window is a fixed 1600 x 1000, so
  // `(max-height: 599px)` could never match it. Written from about:blank because a file://
  // iframe is cross-origin in WebKit and `contentDocument` throws.
  async function frame(width, height, shellClass) {
    const el = document.createElement('iframe')
    el.style.cssText = `width:${width}px;height:${height}px;border:0`
    document.body.appendChild(el)
    const doc = el.contentDocument
    doc.open()
    doc.write('<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>'
      + fixture.css + '</style></head><body class="' + shellClass + '">' + fixture.body + '</body></html>')
    doc.close()
    for (let i = 0; i < 60 && !doc.getElementById('run'); i++) await new Promise((r) => setTimeout(r, 50))
    return { doc, win: el.contentWindow, width, height }
  }

  // `checkVisibility` shipped in Safari 17.4. If this engine predates it the probe cannot answer
  // its central question, and saying so is not the same as observing a defect.
  if (typeof Element.prototype.checkVisibility !== 'function') {
    out.push('CANNOT ANSWER — this WebKit has no Element.checkVisibility(); the visibility contracts below were not evaluated.')
    return out.join('\n')
  }
  // Default `checkVisibility()` only considers `display` and `visibility`. A control faded to
  // `opacity: 0` or collapsed to a zero box is just as unreachable, so ask for all of it and
  // measure the box as well.
  const VIS = { contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }
  const shown = (node) => {
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { ok: node.checkVisibility(VIS) && rect.width > 0 && rect.height > 0, rect }
  }

  let lost = 0
  // A selector that no longer matches must not read as a defect it never observed — the same
  // ANCHOR LOST discipline verify-short-viewport.mjs exits 2 on.
  const get = (f, id) => {
    const node = f.doc.getElementById(id)
    if (!node) { out.push(`FAIL  #${id} — SELECTOR LOST at ${f.width}x${f.height}, re-anchor before trusting this result`); lost += 1 }
    return node
  }

  const A = await frame(1280, 599, 'lw-shell mode-team lib-open')
  const B = await frame(1280, 601, 'lw-shell mode-team lib-open')
  const C = await frame(1100, 599, 'lw-shell mode-team lib-open')
  const D = await frame(1100, 601, 'lw-shell mode-team lib-open')
  const E = await frame(667, 375, 'lw-shell mode-team lib-hidden')

  // --- R0 the denominators ---------------------------------------------------------------
  // Read these before believing anything below: if the short rule never matched, every
  // "survives" contract would pass by measuring the ordinary composer.
  const shortA = A.win.matchMedia('(max-height: 599px)').matches
  const shortB = B.win.matchMedia('(max-height: 599px)').matches
  out.push(`frames: A=${A.width}x${A.height} short=${shortA} · B=${B.width}x${B.height} short=${shortB}`
    + ` · C=${C.width}x${C.height} · D=${D.width}x${D.height} · E=${E.width}x${E.height} narrow=${E.win.matchMedia('(max-width: 767px)').matches}`)
  if (!shortA || shortB) {
    out.push('FAIL  R0 the 599/601 pair does not straddle `(max-height: 599px)` — nothing below measures §13')
    return out.join('\n')
  }
  out.push('PASS  R0  the 599/601 pair straddles the §13 boundary')

  // --- R1/R2/R3 the composer survives, on BOTH sides of the boundary ----------------------
  for (const [label, f] of [['599 (rule ON)', A], ['601 (rule OFF)', B]]) {
    const prompt = shown(get(f, 'prompt'))
    const run = shown(get(f, 'run'))
    const history = shown(get(f, 'history'))
    if (!prompt || !run || !history) continue
    out.push(`${prompt.ok ? 'PASS' : 'FAIL'}  R1  prompt textarea visible at ${label} — ${prompt.rect.width.toFixed(0)}x${prompt.rect.height.toFixed(0)}px`)
    out.push(`${run.ok ? 'PASS' : 'FAIL'}  R2  primary run action visible at ${label} — ${run.rect.width.toFixed(0)}x${run.rect.height.toFixed(0)}px`)
    out.push(`${history.ok ? 'PASS' : 'FAIL'}  R3  run-history (replay) reachable at ${label} — ${history.rect.width.toFixed(0)}x${history.rect.height.toFixed(0)}px`)
  }

  // --- R4 no visible control advertises a dialog that does not paint ----------------------
  // The TNG-203 defect proper. Both popovers are mounted OPEN in the fixture, so this asks the
  // question in the state the operator reaches by pressing the control.
  {
    const controls = [...A.doc.querySelectorAll('[aria-haspopup]')]
    let dead = 0
    let checked = 0
    for (const control of controls) {
      if (!control.checkVisibility(VIS)) continue
      checked += 1
      const target = A.doc.getElementById(control.getAttribute('data-popover') ?? '')
      const state = shown(target)
      if (!state || !state.ok) {
        dead += 1
        out.push(`      ${control.id || control.getAttribute('aria-label')} advertises aria-haspopup="${control.getAttribute('aria-haspopup')}"`
          + ` aria-expanded="${control.getAttribute('aria-expanded')}" at a target that does not render`)
      }
    }
    out.push(`${dead === 0 && checked > 0 ? 'PASS' : 'FAIL'}  R4  dead popover affordances at 599: ${dead} of ${checked} visible aria-haspopup controls`
      + (checked === 0 ? ' — zero controls examined, so this proves nothing' : ''))
  }

  // --- R5 the composer is inside the viewport, not merely undisplayed ---------------------
  // `display: none` is one way to lose the composer. `bottom` is another, and the static gate
  // cannot see it.
  {
    const composer = A.doc.querySelector('.lw-composer')
    const state = shown(composer)
    if (!state) { out.push('FAIL  R5 — .lw-composer SELECTOR LOST, re-anchor before trusting this result'); lost += 1 }
    else {
      const inside = state.rect.top >= 0 && state.rect.bottom <= A.height && state.rect.left >= 0 && state.rect.right <= A.width
      out.push(`${state.ok && inside ? 'PASS' : 'FAIL'}  R5  composer inside the 1280x599 viewport — `
        + `top ${state.rect.top.toFixed(0)}, bottom ${state.rect.bottom.toFixed(0)} of ${A.height}`)
    }
  }

  // --- R6 the popovers cap to the viewport instead of disappearing -------------------------
  // The design ruling TNG-203 turns on: `.mode-pop` was hidden because it "cannot fit". Bounded
  // by `max-height` it fits at any height, which is what makes R4 satisfiable without stripping
  // the chip's ARIA. Filler is injected so the cap is load-bearing — without it the fixture's
  // own content is short enough that any rule would pass.
  {
    const pop = A.doc.getElementById('modepop')
    if (!pop) { out.push('FAIL  R6 — #modepop SELECTOR LOST, re-anchor before trusting this result'); lost += 1 }
    else {
      const guards = pop.querySelector('.mp-guards')
      for (let i = 0; i < 40; i++) {
        const filler = A.doc.createElement('span')
        filler.className = 'mp-note t-meta'
        filler.textContent = `overflow probe row ${i} — forces the popover past the viewport unless it is capped`
        guards.appendChild(filler)
      }
      const rect = pop.getBoundingClientRect()
      const capped = rect.top >= 0 && rect.bottom <= A.height
      const scrolls = pop.scrollHeight > pop.clientHeight
      out.push(`${capped && scrolls ? 'PASS' : 'FAIL'}  R6  overfilled mode popover stays in the 599px viewport and scrolls — `
        + `top ${rect.top.toFixed(0)}, bottom ${rect.bottom.toFixed(0)} of ${A.height}, scrollHeight ${pop.scrollHeight} vs client ${pop.clientHeight}`)
    }
  }

  // --- R9 the capped popovers still clear the composer they belong to ----------------------
  // Re-anchoring a popover's `bottom` to reclaim height is only a gain if it still clears the
  // control that opens it. The composer is not a fixed 44 px: `.comp-note` carries the §6.3
  // preflight blocker, and with it the band is ~57 px. A popover that opens *through* its own
  // composer is a milder version of the same complaint as one that never paints.
  {
    const composer = A.doc.querySelector('.lw-composer')
    if (!composer) { out.push('FAIL  R9 — .lw-composer SELECTOR LOST, re-anchor before trusting this result'); lost += 1 }
    else {
      const top = composer.getBoundingClientRect().top
      for (const [name, id] of [['mode popover', 'modepop'], ['run history', 'historypop']]) {
        const pop = A.doc.getElementById(id)
        if (!pop) { out.push(`FAIL  R9 — #${id} SELECTOR LOST, re-anchor before trusting this result`); lost += 1; continue }
        const bottom = pop.getBoundingClientRect().bottom
        out.push(`${bottom <= top ? 'PASS' : 'FAIL'}  R9  ${name} clears the composer at 599 — `
          + `popover bottom ${bottom.toFixed(0)} vs composer top ${top.toFixed(0)}`
          + (bottom > top ? ` (overlaps by ${(bottom - top).toFixed(0)}px)` : ` (${(top - bottom).toFixed(0)}px clear)`))
      }
    }
  }

  // --- R7 the clustering — the one thing that MAY differ across the boundary ---------------
  // Measured at 1100 px with the library open, because that is where the 768-1179 rule stacks
  // `.lw-viewctl` into a second band. At 1280 the stacking rule never applies, so a 1280 pair
  // would report "no difference" and score a missing merge as a pass.
  {
    const short = get(C, 'viewctl')
    const tall = get(D, 'viewctl')
    if (short && tall) {
      const gapShort = C.height - short.getBoundingClientRect().bottom
      const gapTall = D.height - tall.getBoundingClientRect().bottom
      out.push(`${gapShort < gapTall ? 'PASS' : 'FAIL'}  R7  view controls merge down into the composer band at 1100x599 — `
        + `${gapShort.toFixed(0)}px above the viewport floor vs ${gapTall.toFixed(0)}px at 1100x601`)
    }
  }

  // --- R8 the short+narrow intersection keeps the 44 px target -----------------------------
  // 667 x 375 matches BOTH media queries. §11.6 failure 21 makes 44 px a contract below 768 px,
  // and the height rule must not undercut it. (At 1280 the base `.btn` is 28 px by design, so
  // asserting 44 px there would invent a promise §13 never made.)
  {
    const run = get(E, 'run')
    const prompt = get(E, 'prompt')
    if (run && prompt) {
      const runState = shown(run)
      const promptState = shown(prompt)
      out.push(`${runState.ok && runState.rect.height >= 44 ? 'PASS' : 'FAIL'}  R8  run action at 667x375 (short AND narrow) — `
        + `${runState.rect.height.toFixed(1)}px, visible ${runState.ok}`)
      out.push(`${promptState.ok ? 'PASS' : 'FAIL'}  R8b prompt textarea at 667x375 — `
        + `${promptState.rect.width.toFixed(0)}x${promptState.rect.height.toFixed(0)}px`)
    }
  }

  if (lost > 0) out.push(`${lost} anchor(s) lost — those contracts were not evaluated.`)
  return out.join('\n')
})()
