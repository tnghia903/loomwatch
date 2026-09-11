/* WebKit probe — the thirteen TNG-90 run/provenance states, in the engine the
 * board actually reviews in.
 *
 * Twelve are named by TNG-90's acceptance criteria; the thirteenth is
 * finished-with-no-answer (`missing_canonical_response`, §3.4), added after
 * TNG-166.
 *
 *   swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
 *   /tmp/verify-webkit docs/mockups/prototype-standalone.html \
 *     --eval-async docs/mockups/webkit-probe-tng90-states.js
 *
 * Why this exists next to verify-tng90-states.mjs
 * -----------------------------------------------
 * That gate is the authority on these states and it passes 47/0. It drives
 * headless Chrome. Every board rejection on this prototype so far — the library
 * drag that started a text selection, the canvas nodes that would not move, the
 * view controls that answered nothing — was invisible to a Chrome gate and
 * obvious in Safari on the first press. The Gate B card tells the board to open
 * `#compose #running #answered #trace`, and until this file ran, not one of
 * those four screens had ever been exercised in WebKit.
 *
 * So this is not a port of the Chrome gate. It asserts the things whose answer
 * can legitimately differ between engines, and it says so at each check:
 *
 *   - `checkVisibility()` is the Chrome gate's central instrument — it is how
 *     that gate refuses to count the prototype's hidden `#states.board`
 *     specimen gallery. If WebKit lacks it, every visibility claim made about
 *     this artifact is a Chrome-only claim. Asserted first, and fatally.
 *   - Layout-dependent reads (`offsetParent`, laid-out strip counts, the
 *     one-hop-at-a-time expansion) resolve through WebKit's own layout.
 *   - The dirty → save → run ordering runs on WebKit's event loop rather than
 *     Chrome's, which is the entire reason this file needs `--eval-async`.
 *   - Theme resolution is `color-mix()` and custom properties on this build;
 *     computed-value serialization is exactly where engines diverge.
 *
 * Navigation is the prototype's own `go()` rather than a hash reload, because
 * `hashchange` reloads the page and would end the probe's world. `go()` re-runs
 * `SEEDS[screen]`, which `Object.assign`s every mutable field of `run`, so each
 * screen starts from the same state a reviewer's fresh load would.
 */
(async () => {
  const out = [];
  let fails = 0;
  const ok = (cond, label, detail) => {
    out.push((cond ? '  ok   ' : '  FAIL ') + label + (detail == null ? '' : ' — ' + detail));
    if (!cond) fails++;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (q) => (document.querySelector(q)?.textContent || '').trim();

  /* `go`, `submitRun`, `toggleCat`, `paintRun` and `paintTheme` are function
     declarations, so they hang off `window`; `run` and `state` are top-level
     `const`/`let`, which live in the global *lexical* environment and never
     become window properties. Bare identifiers reach both, which is why every
     probe in this directory reads `state` and `run` unqualified. */

  out.push('engine: WebKit / WKWebView (the engine Safari uses)');
  out.push('artifact: ' + location.href.replace(/^.*\//, ''));
  out.push('');

  /* ---- 0. The instrument itself ------------------------------------------
     Every visibility claim below, and every one the Chrome gate makes, runs
     through checkVisibility(). If WebKit does not implement it the probe must
     stop rather than quietly fall back to a presence check — the prototype
     ships a hidden specimen gallery of every capture card, so a presence check
     reports four capture states on a screen that renders none. */
  out.push('INSTRUMENT — the visibility test the whole gate rests on');
  const hasCV = typeof Element.prototype.checkVisibility === 'function';
  ok(hasCV, 'WebKit implements Element.checkVisibility()',
    hasCV ? 'available' : 'MISSING — visibility claims about this artifact are Chrome-only');
  if (!hasCV) {
    out.push('');
    out.push('FAIL cannot measure this artifact in WebKit without checkVisibility()');
    return out.join('\n');
  }
  const shown = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  /* The counterfactual that proves checkVisibility is doing work here rather
     than returning true for everything: the trace screen carries far more
     `.ent` cards in the DOM than it renders, because the prototype keeps a
     hidden specimen gallery of every capture card. A stub that returned `true`
     would report the DOM-wide count and fail this. */
  go('trace');
  const entsAll = document.querySelectorAll('.ent').length;
  const entsShown = [...document.querySelectorAll('.ent')].filter(shown).length;
  ok(entsAll > entsShown && entsShown > 0,
    'and it discriminates — the DOM holds more cards than the screen renders',
    entsAll + ' in the DOM, ' + entsShown + ' actually on screen');

  /* Recorded, not asserted: this harness renders offscreen, so the animation
     timeline does not advance. It is why the theme section below reads tokens
     instead of transitioned paint. If a future WebKit starts ticking rAF here,
     this line will say so and the workaround can be revisited. */
  const frames = await new Promise((r) => {
    let n = 0;
    const tick = () => { if (++n >= 3) return r(n); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => r(n), 1000);
  });
  out.push('  note   animation clock: ' + frames + ' rAF frames in 1s'
    + (frames === 0 ? ' — offscreen timeline is frozen, transitions never advance' : ''));
  out.push('');

  /* ---- 1. Document states: clean / dirty / invalid ------------------------ */
  out.push('DOCUMENT — the chip is the document\'s state surface (§9.1)');
  go('team');
  const cleanL2 = txt('#chipL2');
  const cleanAct = txt('#chipAction');
  ok(cleanL2 === '~/.loomwatch/teams' && cleanAct === '',
    'clean — chip names the file with no pending write',
    JSON.stringify({ l2: cleanL2, action: cleanAct }));

  go('canvas');
  const dirtyL2 = txt('#chipL2');
  const dirtyAct = txt('#chipAction');
  ok(dirtyL2 === '3 lines differ', 'dirty — chip reports a magnitude, not a state word',
    JSON.stringify(dirtyL2));
  ok(/Save/.test(dirtyAct) && cleanAct === '',
    'dirty — offers the write, and clean does not (counterfactual)',
    'dirty=' + JSON.stringify(dirtyAct) + ' clean=' + JSON.stringify(cleanAct));

  go('problems');
  ok(/problem/i.test(txt('#chipL1')) && /Review/.test(txt('#chipAction')),
    'invalid — chip counts the problems and offers review',
    JSON.stringify({ l1: txt('#chipL1'), action: txt('#chipAction') }));
  out.push('');

  /* ---- 2. dirty/Save & run — a run executes saved bytes -------------------
     TNG89_INTERACTION §1.4 is normative: there is no run-without-saving. This
     is the defect that was fixed at be2ca55, and the reason the composer's
     dirty variant had to become reachable — the string lived in COMPOSER.dirty
     as dead data while renderComposer was only ever called with 'notion' or
     'empty', so a grep for "Save & run" returned three hits and proved nothing. */
  out.push('SAVE & RUN — §1.4, a run executes an exact byte snapshot');
  go('compose');
  const compButtons = [...document.querySelectorAll('#compAct .btn')].map((b) => b.textContent.trim());
  ok(txt('#chipL2') === '3 lines differ',
    'composer — the run screen is reached with a dirty document', JSON.stringify(txt('#chipL2')));
  ok(/Save & run/.test(compButtons.join(' | ')),
    'dirty composer offers Save & run, not a bare Run', JSON.stringify(compButtons));

  /* The ordering claim, on WebKit's event loop. saveAndRun() writes through a
     doSave callback and only then calls submitRun(), so the assertion is not
     "a run exists" but "the document was no longer dirty by the time it did".
     Asserting on the next tick is how this check failed against a correct
     build, so it waits for the phase to leave idle rather than sampling once. */
  submitRun('Find out how ACP negotiates capabilities.');
  const started = Date.now();
  while (run.phase === 'idle' && Date.now() - started < 6000) await sleep(40);
  const phaseAfter = run.phase;
  const chipAfter = txt('#chipL2');
  ok(phaseAfter !== 'idle', 'submitting from a dirty document does start a run',
    'phase=' + phaseAfter + ' after ' + (Date.now() - started) + 'ms');
  ok(chipAfter !== '3 lines differ',
    'and the document was written before the run was created',
    'phase=' + phaseAfter + ' chip=' + JSON.stringify(chipAfter));
  /* queued must name what it is waiting for, not just exist. */
  ok(/Queued/i.test(document.body.innerText) || phaseAfter !== 'queued',
    'queued — the run names what it waits for', 'phase=' + phaseAfter);
  out.push('');

  /* ---- 3. Run lifecycle: the phase surface, read through layout -----------
     innerText falls back to textContent on an element that is not rendered, so
     reading .run-meta directly is a presence check wearing a visibility
     costume. Every read of the phase surface goes through shown(). */
  out.push('LIFECYCLE — running / succeeded, read off the laid-out phase surface');
  const meta = () => {
    const el = document.querySelector('.run-meta');
    return el && shown(el) ? el.innerText.trim() : '';
  };
  go('running');
  const liveMeta = meta();
  ok(/·\s*running\b/i.test(liveMeta) && run.phase === 'running',
    'streaming — live screen reports the run in flight',
    'run-meta=' + JSON.stringify(liveMeta) + ' phase=' + run.phase);

  go('trace');
  const doneMeta = meta();
  ok(/Answered in\s+\S/i.test(document.body.innerText),
    'complete — finished run reports its duration');
  ok(/·\s*succeeded\b/i.test(doneMeta) && !/·\s*running\b/i.test(doneMeta),
    'complete — the finished screen reports succeeded, not running (counterfactual)',
    'run-meta=' + JSON.stringify(doneMeta));
  out.push('');

  /* ---- 4. Partial failure — content retained, error verbatim -------------- */
  out.push('PARTIAL FAILURE — the answer survives, the error is verbatim');
  go('answered');
  const strip = document.querySelector('.rt-strip.alert');
  const stripText = strip ? strip.innerText : '';
  /* .rt-body is the *prompt* body; the answer lives in .rt-response. Measuring
     the wrong one scored a healthy screen at 67 characters. */
  const answerChars = (document.querySelector('.rt-response')?.innerText || '').length;
  ok(!!strip && shown(strip) && /Partial answer/i.test(document.body.innerText) && answerChars > 200,
    'alert strip is laid out and the answer text is retained in full',
    'strip=' + !!strip + ' answerChars=' + answerChars);
  ok(/process_crashed/.test(stripText),
    'the daemon error is verbatim, with its stable code', JSON.stringify(stripText));
  const agentStates = () => [...document.querySelectorAll('.node-task b')]
    .filter(shown).map((el) => el.innerText.trim());
  const partialAgents = agentStates();
  /* Paired with the clean row asserted on `unanswered` below: this proves the
     selector can see a failed agent, so `every(DONE)` there is an observation
     rather than an empty NodeList quietly passing. */
  ok(partialAgents.length > 0 && partialAgents.some((s) => /ERROR/i.test(s)),
    'the crashed agent reports ERROR in the graph', JSON.stringify(partialAgents));
  out.push('');

  /* ---- 4b. Finished, no answer — §3.4's other failure shape ---------------
     Added after TNG-166 caught the implementation reporting a clean run with
     no answer as `process_crashed`. The spec always separated the two; the
     prototype had only ever drawn the crash, so there was no rendered
     reference to deviate from. */
  out.push('NO ANSWER — §3.4, a run that finished clean and produced nothing');
  go('unanswered');
  const naStrip = [...document.querySelectorAll('.rt-strip.alert')].filter(shown);
  const naStripText = naStrip.map((el) => el.innerText).join(' ~ ');
  const naResponse = document.querySelector('.rt-response');
  const naText = naResponse ? naResponse.innerText : '';
  ok(/missing_canonical_response/.test(naStripText),
    'the run reports missing_canonical_response', JSON.stringify(naStripText));
  ok(!/process_crashed|crashed/i.test(naText),
    'it is NOT reported as a crash (counterfactual)', JSON.stringify(naStripText));
  const naBodies = [...document.querySelectorAll('.rt-response .rr-body')].filter(shown).length;
  ok(naBodies === 0 && document.querySelectorAll('.rt-response .skel-bar').length === 0,
    '§3.4: failed has no content, so the node is the strip', 'laid-out bodies=' + naBodies);
  const naPlain = document.querySelector('.rt-response .rr-plain');
  ok(!!naPlain && shown(naPlain) && /finished but no agent produced an answer/i.test(naPlain.innerText),
    'the plain-language second line is on screen, below the verbatim code',
    JSON.stringify(naPlain ? naPlain.innerText : ''));
  const naActs = [...document.querySelectorAll('.rt-response .rr-acts button')]
    .filter(shown).map((b) => b.innerText.trim());
  ok(naActs.some((t) => /^Reuse$/i.test(t)), 'Reuse is offered as the action on the node',
    JSON.stringify(naActs));
  const naAgents = agentStates();
  ok(naAgents.length > 0 && naAgents.every((s) => /DONE/i.test(s)),
    'every agent exited clean, so the graph shows no error', JSON.stringify(naAgents));
  ok([...document.querySelectorAll('.rt-chip')].filter(shown).length === 6,
    'a run without an answer still reports its provenance',
    'chips=' + [...document.querySelectorAll('.rt-chip')].filter(shown).length);
  out.push('');

  /* ---- 5. Reconnect — a transport gap that never rewrites run state -------
     CONTRACT §3.2: reconnection must not read as pause/cancel. The prototype
     keeps hidden specimens of the other terminal strips in the DOM, so presence
     proves nothing — only a laid-out strip is on screen. */
  out.push('RECONNECT — §3.2, a transport gap is not a run state');
  const visibleHalt = () => [...document.querySelectorAll('.rt-strip.halt')].filter(shown);
  go('running');
  const haltLive = visibleHalt();
  ok(haltLive.length === 1, 'live screen carries exactly one visible transport gap strip',
    'visible halt strips = ' + haltLive.length);
  ok(/seq\s*\d+/i.test(haltLive.map((el) => el.innerText).join(' ~ ')),
    'the gap names its watermark rather than saying only "reconnecting"',
    JSON.stringify(haltLive.map((el) => el.innerText).join(' ~ ')));
  ok(/·\s*running\b/i.test(meta()),
    'run indicator still reports the run, not the transport', 'run-meta=' + JSON.stringify(meta()));
  go('trace');
  ok(visibleHalt().length === 0, 'finished run shows no gap strip (counterfactual)',
    'finished screen showed ' + visibleHalt().length + ' visible halt strips');
  out.push('');

  /* ---- 6. Provenance summary — six categories, fixed order ----------------
     Fixed order is the requirement (the operator learns positions), so assert
     the sequence, not the set. */
  out.push('PROVENANCE — six contract categories in contract order');
  go('answered');
  const chips = [...document.querySelectorAll('.rt-chip')].filter(shown)
    .map((c) => c.innerText.trim().toLowerCase());
  const want = ['agents', 'reasoning', 'skills', 'tools', 'commands', 'sources'];
  const seen = want.filter((w) => chips.some((c) => c.includes(w)));
  ok(seen.length === 6, 'all six categories are on screen',
    'saw ' + JSON.stringify(seen) + ' in ' + JSON.stringify(chips));
  const idx = want.map((w) => chips.findIndex((c) => c.includes(w)));
  ok(idx.every((v, i) => v !== -1 && (i === 0 || v > idx[i - 1])),
    'and they hold the contract order', JSON.stringify(idx));
  out.push('');

  /* ---- 7. One hop at a time ----------------------------------------------
     The promise is that expanding a category does not explode the graph. Two
     depths exist and render differently on purpose: with a category open the
     six chips show with one `.open`; with an *entity* open the chip row is
     replaced by a breadcrumb, because showing both would be two hops at once.
     `trace` ships at the deeper of the two. */
  out.push('ONE HOP — expansion opens one edge and does not explode the graph');
  go('trace');
  const depth = run.openEnt ? 'entity' : run.open ? 'category' : 'none';
  const allChips = document.querySelectorAll('.rt-chip').length;
  const openEnts = [...document.querySelectorAll('.ent.open')].filter(shown).length;
  ok(depth === 'entity' || depth === 'category',
    'the trace screen is at exactly one expansion depth', 'depth=' + depth);
  if (depth === 'entity') {
    ok(openEnts === 1 && allChips === 0 && !!document.querySelector('.tray-crumb'),
      'one entity expanded, and the chip row yields to a breadcrumb',
      'openEnts=' + openEnts + ' chips=' + allChips);
  } else {
    ok(document.querySelectorAll('.rt-chip.open').length === 1 && allChips === 6,
      'exactly one of the six categories is expanded', 'chips=' + allChips);
  }
  ok([...document.querySelectorAll('.ent')].filter(shown).length > 0,
    'the expanded hop renders its entities');
  ok(/Back to response/i.test(document.body.innerText),
    'a collapse path back to the response exists');

  /* Drive a real expansion and assert the graph did not explode. */
  go('answered');
  toggleCat('tools');
  const cats = [...document.querySelectorAll('.rt-chip')];
  const opened = cats.filter((c) => c.classList.contains('open')).map((c) => c.dataset.category);
  ok(opened.length === 1 && opened[0] === 'tools',
    'expanding a category opens that one and no other', 'open=' + JSON.stringify(opened));
  ok(cats.length === 6, 'the six categories survive the expansion', 'chips=' + cats.length);
  ok(/tools/i.test(document.querySelector('.tray-cat-label')?.innerText || ''),
    'the opened hop names the edge kind it expanded along',
    JSON.stringify(document.querySelector('.tray-cat-label')?.innerText || ''));
  out.push('');

  /* ---- 8. Capture states — four, each reached by a real hop ---------------
     querySelectorAll('.cap-*') is not a measurement of this screen: the hidden
     specimen gallery holds two copies of every capture card, so a DOM-wide
     count reads 2/2/2/2 on *every* screen, including `team`, which has no
     evidence on it at all. Each state is asserted visibly rendered. */
  out.push('CAPTURE — four states, each one hop away, counted through layout');
  const caps = () => {
    const of = (c) => [...document.querySelectorAll('.cap-' + c)].filter(shown);
    return {
      recorded: of('recorded').length, derived: of('derived').length,
      redacted: of('redacted').length, unavailable: of('unavailable').length,
      redactedText: of('redacted').map((el) => el.innerText),
      unavailableText: of('unavailable').map((el) => el.innerText)
    };
  };
  go('trace');
  ok(caps().recorded > 0, 'the trace screen shows recorded evidence at rest',
    JSON.stringify(caps()));
  go('team');
  const none = caps();
  ok(none.recorded === 0 && none.derived === 0 && none.redacted === 0 && none.unavailable === 0,
    'a screen with no evidence shows no capture cards (counterfactual)', JSON.stringify(none));

  const hops = { derived: 'commands', unavailable: 'tools', redacted: 'sources' };
  let redactedShown = [];
  let unavailableShown = [];
  for (const state of Object.keys(hops)) {
    go('answered');
    toggleCat(hops[state]);
    const c = caps();
    if (state === 'redacted') redactedShown = c.redactedText;
    if (state === 'unavailable') unavailableShown = c.unavailableText;
    ok(c[state] > 0, state + ' evidence renders one hop into ' + hops[state],
      hops[state] + ' showed ' + JSON.stringify({ recorded: c.recorded, derived: c.derived,
        redacted: c.redacted, unavailable: c.unavailable }));
  }
  /* ADR 0005 §7 fails closed. `.some()` over an empty list is false, so the
     population is asserted first — otherwise this passes loudest exactly when
     redaction has vanished from the screen. */
  ok(redactedShown.length > 0
    && !redactedShown.some((t) => /reveal|show|request access|unlock/i.test(t)),
    'no hover-to-reveal or request-access affordance on a visible redacted card',
    redactedShown.length + ' redacted card(s) on screen');
  ok(unavailableShown.length > 0 && unavailableShown.some((t) => /adapter|no |not /i.test(t)),
    'unavailable evidence states a reason', JSON.stringify(unavailableShown));
  out.push('');

  /* ---- 9. Themes ---------------------------------------------------------
     Read the tokens, never the transitioned paint.

     `#stage` declares `transition: background-color 240ms`, and this harness
     runs the page in an offscreen WKWebView whose animation timeline never
     advances — rAF is measured at 0 frames per second below. A transitioned
     property is therefore frozen at its from-value forever, so sampling
     `getComputedStyle(#stage).backgroundColor` after a theme flip reports the
     *old* ground no matter how long the probe waits. An earlier draft of this
     file did exactly that and reported a broken light theme on an artifact
     that is correct: Chrome resolves the same flip to rgb(250,248,243) at
     t=600ms, and disabling the transition here resolves it immediately.

     The tokens themselves are not transitioned, so they are the honest
     measurement — and they are what every themed surface derives from. */
  out.push('THEMES — the theme tokens re-resolve (transition-free measurement)');
  const token = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  go('trace');
  state.theme = 'dark'; paintTheme();
  const darkGround = token('--color-ground'); const darkAccent = token('--color-accent');
  state.theme = 'light'; paintTheme();
  const lightGround = token('--color-ground'); const lightAccent = token('--color-accent');
  ok(!!darkGround && !!lightGround && darkGround !== lightGround,
    'ground re-resolves per theme on the trace screen',
    'dark=' + darkGround + ' light=' + lightGround);
  ok(!!darkAccent && !!lightAccent && darkAccent !== lightAccent,
    'accent re-resolves per theme (gold vs bronze)',
    'dark=' + darkAccent + ' light=' + lightAccent);
  /* The token is only worth asserting if something paints from it. With the
     transition suppressed the used value is observable even offscreen, so this
     closes the gap between "the token changed" and "the canvas changed". */
  const killT = document.createElement('style');
  killT.textContent = '#stage { transition: none !important; }';
  document.head.appendChild(killT);
  state.theme = 'light'; paintTheme();
  const paintedLight = getComputedStyle(document.querySelector('#stage')).backgroundColor;
  state.theme = 'dark'; paintTheme();
  const paintedDark = getComputedStyle(document.querySelector('#stage')).backgroundColor;
  killT.remove();
  ok(paintedLight !== paintedDark && /^rgb\(2[45]\d/.test(paintedLight),
    'and the canvas ground actually repaints from it',
    'light=' + paintedLight + ' dark=' + paintedDark);
  state.theme = 'dark'; paintTheme();
  out.push('');

  /* ---- 10. Reduced motion, through the control a reviewer can press -------
     The Chrome gate emulates `prefers-reduced-motion: reduce`, which trips the
     media block's universal `*` rule and stops everything. That is the OS
     preference path. It is not the path a reviewer takes: the prototype ships
     its own "Motion: reduced" button, which sets `[data-motion="reduce"]`, and
     that path had no universal rule — it listed selectors by hand, so it only
     covered surfaces that existed when it was written.

     So this presses the button, and asserts against the counterfactual that
     makes it a gate rather than a vacuous claim: the previously reviewed
     `canvas` screen must reach zero, and the TNG-90 `running` screen must too.
     Before the CSS fix this read 3 on `running` and 0 on `canvas` — the two
     numbers differing is the whole finding, and one number alone could not
     have expressed it.

     `animationPlayState` and `animationIterationCount` are declared values,
     not timeline samples, so unlike the theme check above these survive this
     harness's frozen animation clock. */
  out.push('REDUCED MOTION — the in-app button, not the OS preference');
  const stillMoving = () => [...document.querySelectorAll('#stage *')].filter(shown)
    .map((el) => ({ el, cs: getComputedStyle(el) }))
    .filter(({ cs }) => cs.animationName !== 'none' && cs.animationDuration !== '0s'
      && cs.animationIterationCount === 'infinite' && cs.animationPlayState !== 'paused');

  go('running');
  const motionBtn = document.querySelector('#motionBtn');
  ok(!!motionBtn && shown(motionBtn), 'the Motion control is reachable on the live screen');
  const movingBefore = stillMoving().length;
  ok(movingBefore > 0,
    'the live screen genuinely animates before the button is pressed (counterfactual)',
    movingBefore + ' infinite animations playing');

  motionBtn.click();
  ok(document.documentElement.dataset.motion === 'reduce'
    && /reduced/i.test(motionBtn.textContent),
    'pressing it puts the document in the reduced-motion state',
    'data-motion=' + document.documentElement.dataset.motion
      + ' label=' + JSON.stringify(motionBtn.textContent));

  const liveLeft = stillMoving();
  ok(liveLeft.length === 0,
    'no infinite animation survives on the TNG-90 live screen',
    liveLeft.length + ' still playing: '
      + JSON.stringify(liveLeft.map(({ el, cs }) => el.className + '/' + cs.animationName)));
  ok(/·\s*running\b/i.test(meta()),
    'and the live state is still legible without motion', 'run-meta=' + JSON.stringify(meta()));

  go('canvas');
  const canvasLeft = stillMoving();
  ok(canvasLeft.length === 0,
    'and the previously reviewed canvas screen is still covered too',
    canvasLeft.length + ' still playing');
  out.push('');

  out.push(fails
    ? 'FAIL ' + fails + ' assertion(s) — the TNG-90 states do not hold in WebKit'
    : 'PASS all thirteen TNG-90 states hold in WebKit, the engine the board reviews in');
  return out.join('\n');
})()
