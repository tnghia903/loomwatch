/* WebKit probe — TNG-90 §11.6 against the *prototype*, below 768 px.
 *
 *   node docs/mockups/build-prototype-narrow-fixture.mjs
 *   swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
 *   /tmp/verify-webkit <fixture>/host.html --eval-async docs/mockups/webkit-probe-prototype-narrow.js
 *
 * Why this exists
 * ---------------
 * §11.6 is a claim about the prototype. TNG-173 closed its four contracts against `ui/`
 * production source, and `verify-narrow-conformance.mjs` reads only that. The Gate B card
 * pins the prototype, so the artifact the board is asked to approve had never been measured
 * at the width its own spec legislates. This closes that, in the engine the board reviews in.
 *
 * Two traps this file is built to avoid, both of which have produced false readings here:
 *
 *   - The stage is a 1600 px design scaled by a transform, so rendered geometry read at wide
 *     width is ~0.92x the authored value. The narrow rules set `transform: none`, and T1
 *     asserts that *before* any 44 px claim is believed — an un-reset transform would make
 *     44 px read as 40.6 px and this probe would report a defect that does not exist.
 *   - `querySelectorAll` counts the prototype's hidden `#states` specimen gallery. Every
 *     measurement below goes through `checkVisibility()`, and every check prints its
 *     denominator: "0/0 targets under 44 px" is not a pass, it is a probe that found nothing.
 *
 * Measurements are scoped to `#stage` — `#protobar` is the prototype's own harness chrome,
 * not the product surface §11.6 governs.
 */
(async () => {
  const out = []
  let fails = 0
  const ok = (cond, label, detail) => {
    out.push((cond ? '  ok   ' : '  FAIL ') + label + (detail == null ? '' : ' — ' + detail))
    if (!cond) fails++
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const host = JSON.parse(document.getElementById('proto').textContent)

  const frame = document.createElement('iframe')
  frame.style.cssText = 'width:375px;height:1400px;border:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write(host)
  doc.close()

  const win = frame.contentWindow
  for (let i = 0; i < 80 && !doc.getElementById('stage'); i++) await sleep(50)
  for (let i = 0; i < 80 && typeof win.go !== 'function'; i++) await sleep(50)
  await sleep(250)

  const stage = doc.getElementById('stage')
  if (!stage || typeof win.go !== 'function') {
    return '  FAIL  prototype did not boot inside the iframe — nothing was measured\n' +
      `\nFAIL stage=${stage ? 'present' : 'MISSING'} go=${typeof win.go}`
  }

  /* checkVisibility is the instrument every later claim rests on. If WebKit lacks it, the
     visibility half of this probe is a Chrome-only claim and must not be reported as a pass. */
  const el0 = doc.createElement('div')
  ok(typeof el0.checkVisibility === 'function', 'checkVisibility() exists in this engine',
    typeof el0.checkVisibility)
  if (typeof el0.checkVisibility !== 'function') {
    return out.join('\n') + '\n\nFAIL — visibility cannot be established in this engine.'
  }

  const vis = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  const shown = (sel, root) => [...(root || stage).querySelectorAll(sel)].filter(vis)

  // ---- T1 the measuring conditions themselves -------------------------------------------
  const narrowApplies = win.matchMedia('(max-width: 767px)').matches
  ok(win.innerWidth === 375 && narrowApplies,
    'T1a §11.6 the narrow rules are the ones under measurement',
    `viewport=${win.innerWidth}px matches=${narrowApplies}`)

  const tf = win.getComputedStyle(stage).transform
  const scale = tf && tf !== 'none' ? Number(tf.match(/matrix\(([^,]+)/)?.[1] ?? 1) : 1
  ok(tf === 'none' || Math.abs(scale - 1) < 0.001,
    'T1b §11.6 whole-stage scaling is dropped, so px read here are real px',
    `transform=${tf} scale=${scale}`)

  const screens = ['compose', 'running', 'answered', 'trace']

  // ---- T2 failure 21: core actions render at 44 px --------------------------------------
  // "A viewport below 768 px ... makes a core action smaller than 44 px. Fail."
  const SEL = '.btn, .iconbtn, .mode-chip, .filt, .seg button'
  let measured = 0
  const undersized = []
  for (const key of screens) {
    win.go(key)
    await sleep(160)
    for (const el of shown(SEL)) {
      const h = el.getBoundingClientRect().height
      measured++
      if (h < 43.5) {
        const name = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28)
        undersized.push(`${key}:${el.className.split(' ')[0]}"${name}"=${h.toFixed(1)}px`)
      }
    }
  }
  ok(measured >= 20, 'T2a the 44 px contract actually found controls to measure',
    `${measured} visible core actions across ${screens.join(' ')}`)
  ok(measured >= 20 && undersized.length === 0,
    'T2b §11.6 failure 21 — no core action renders below 44 px',
    undersized.length ? undersized.slice(0, 6).join(', ') : `0/${measured} undersized`)

  // ---- T3 failure 21: theme switching is not hidden -------------------------------------
  win.go('answered')
  await sleep(160)
  const themeBtns = shown('#themeBtn, #themeBtn2')
  ok(themeBtns.length > 0, 'T3a §11.6 failure 21 — theme switching stays reachable at 375 px',
    `${themeBtns.length} visible theme control(s)`)
  if (themeBtns.length) {
    const before = doc.documentElement.getAttribute('data-theme')
    themeBtns[0].click()
    await sleep(200)
    const after = doc.documentElement.getAttribute('data-theme')
    ok(before !== after, 'T3b the theme control actually switches the theme, not just renders',
      `${before} -> ${after}`)
    themeBtns[0].click()
    await sleep(160)
  }

  // ---- T4 failure 21: the composer and response are not clipped -------------------------
  const composer = doc.getElementById('composer')
  ok(composer && vis(composer), 'T4a §11.6 failure 21 — the composer is not clipped away',
    composer ? `visible=${vis(composer)}` : 'MISSING')
  const overflow = stage.scrollWidth - stage.clientWidth
  ok(overflow <= 1, 'T4b §11.6 failure 21 — no horizontal clipping of the column',
    `scrollWidth-clientWidth=${overflow}px`)

  // ---- T5 failure 22: provenance survives narrow ----------------------------------------
  // "Narrow mode loses submission, response/provenance selection, filtering ... Fail."
  win.go('trace')
  await sleep(220)
  // The narrow column carries the evidence entities themselves (`.activity-ent`), not a
  // separate summary list — §4.4's "one detail surface, not two". An earlier draft of this
  // probe looked for `.ent` and reported a defect that did not exist: `activity-ent` is a
  // different class token, and the nested `.ent [aria-expanded]` wanted a descendant of a
  // node that is itself the expander. Both legs are anchored to the rendered tree now.
  const summaries = shown('#overlay .activity-ent, #overlay #provTray, #overlay .prov-empty')
  ok(summaries.length >= 5,
    'T5a §11.6 failure 22 — provenance is present in the narrow column, not lost with the canvas',
    `${summaries.length} visible provenance element(s)`)

  const expanders = shown('#overlay [aria-expanded]')
  ok(expanders.length > 0, 'T5b §11.6 failure 22 — a reachable control expands provenance at 375 px',
    `${expanders.length} visible expander(s)`)
  /* One hop at a time (AC #2): activating a collapsed entity expands *that* entity. The
     assertion is on its own aria-expanded rather than on "did anything change" — a press
     that merely selected a card would satisfy a looser probe while expanding nothing.

     The element must be re-queried after the click. Activating a node repaints `#overlay`
     wholesale, so the clicked element is detached (`isConnected === false`) and keeps its
     pre-click attributes forever. Read through a held reference, this check reports
     `false -> false` against a prototype that expanded correctly — a false negative that
     cost this probe two rounds before the detached node showed up. */
  const hop = async (sel, label) => {
    win.go('trace')
    await sleep(240)
    const before = doc.querySelector(sel)
    if (!before || !vis(before)) return ok(false, label, `no visible ${sel} to expand`)
    const was = before.getAttribute('aria-expanded')
    before.click()
    await sleep(300)
    const after = doc.querySelector(sel)
    const now = after ? after.getAttribute('aria-expanded') : 'MISSING'
    ok(was === 'false' && now === 'true', label,
      `${sel}: aria-expanded ${was} -> ${now} (re-queried; clicked element detached=${!before.isConnected})`)
  }
  await hop('#overlay .activity-ent', 'T5c an evidence entity expands one hop at 375 px')
  await hop('#overlay .node.story-agent-a', 'T5d an agent node expands one hop at 375 px')

  const detail = shown('#overlay .ent-out, #overlay .cite, #overlay .rr-body, #overlay .act-detail')
  ok(detail.length > 0, 'T5e one-hop expansion reveals detail in the narrow column',
    `${detail.length} visible detail element(s) after expanding`)

  const submit = shown('#composer .btn, #composer button')
  ok(submit.length > 0, 'T5f §11.6 failure 22 — submission survives narrow',
    `${submit.length} visible composer control(s)`)

  out.push('')
  out.push(fails
    ? `FAIL ${fails} assertion(s) — §11.6 does not hold in the prototype at 375 px`
    : 'PASS §11.6 holds in the prototype at 375 px, in the engine the board reviews in')
  return out.join('\n')
})()
