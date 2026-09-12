#!/usr/bin/env node
/* TNG-90 acceptance probe — the thirteen run/provenance states, asserted.
 *
 * Twelve are the ones TNG-90's acceptance criteria name. The thirteenth is the
 * finished-with-no-answer state (`missing_canonical_response`, §3.4), which
 * TNG-166 forced into the prototype after the implementation invented a crash
 * for it; §4b below owns it.
 *
 * Why this file exists alongside verify-prototype.mjs
 * ---------------------------------------------------
 * verify-prototype.mjs gates the TNG-87 redesign: themes, reduced motion,
 * overflow bounds, keyboard, placement and wiring. It does not check that
 * TNG-90's named states are *reachable by a reviewer*. A state can be fully
 * implemented in the data tables and still be invisible on every screen, and a
 * grep for its label passes either way — the label is in the source.
 *
 * So every check here resolves a state through the screen a reviewer actually
 * opens, and asserts the promised content at that state. Where a claim is
 * comparative ("dirty differs from clean", "only one hop expands"), the probe
 * asserts the counterfactual too, because an assertion that cannot fail is not
 * a gate.
 *
 * Run:  node verify-tng90-states.mjs
 * Set CHROME_BIN when Chrome is not in a standard path.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const artifact = resolve(here, 'prototype-standalone.html');
const chromeBin = process.env.CHROME_BIN || (
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome'
);
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir();
const profile = await mkdtemp(resolve(scratch, 'loomwatch-tng90-'));

const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => resolvePort(value));
  });
});

const chrome = spawn(chromeBin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let socket;
let nextId = 0;
const pending = new Map();
const runtimeErrors = [];

async function endpoint(path) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      if (response.ok) return response.json();
    } catch {}
    await sleep(50);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function connect() {
  const pages = await endpoint('/json/list');
  const page = pages.find((t) => t.type === 'page' && t.url === 'about:blank')
    || pages.find((t) => t.type === 'page');
  if (!page) throw new Error('No inspectable Chrome page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      if (message.method === 'Runtime.exceptionThrown') {
        runtimeErrors.push(message.params.exceptionDetails.text);
      }
      return;
    }
    if (!pending.has(message.id)) return;
    const { resolve: resolveCall, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolveCall(message.result);
  });
  await send('Page.enable');
  await send('Runtime.enable');
}

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolveCall, reject) => pending.set(id, { resolve: resolveCall, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function navigate(hash) {
  const key = hash.split(',')[0];
  const url = `${pathToFileURL(artifact).href}#${hash}`;
  for (let navAttempt = 0; navAttempt < 2; navAttempt += 1) {
    try {
      await send('Page.navigate', { url });
      const alreadyThere = await evaluate(
        `location.href.endsWith(${JSON.stringify('#' + hash)})`).catch(() => false);
      if (alreadyThere) await send('Page.reload');
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const ready = await evaluate(`document.readyState === 'complete'
          && document.querySelector('#stage')?.dataset.screen === ${JSON.stringify(key)}`)
          .catch(() => false);
        if (ready) break;
        await sleep(50);
      }
      await sleep(140);
      return;
    } catch (err) {
      if (navAttempt === 1) throw err;
      await sleep(300);
    }
  }
}

const passes = [];
const failures = [];
function check(label, condition, detail = '') {
  if (condition) passes.push(label);
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

try {
  await connect();

  /* ---------------------------------------------------------------------
     1. Document states: clean / dirty / invalid.
     The chip is the document's state surface (§9.1). Each assertion pairs
     the state's own text with a counterfactual against another state, so a
     chip that stopped switching would fail rather than pass three times.
     --------------------------------------------------------------------- */
  await navigate('team');
  const clean = await evaluate(`({
    l1: document.querySelector('#chipL1')?.textContent.trim(),
    l2: document.querySelector('#chipL2')?.textContent.trim(),
    action: document.querySelector('#chipAction')?.textContent.trim()
  })`);
  check('clean — chip names the file with no pending write',
    clean.l2 === '~/.loomwatch/teams' && clean.action === '', JSON.stringify(clean));

  await navigate('canvas');
  const dirty = await evaluate(`({
    l2: document.querySelector('#chipL2')?.textContent.trim(),
    action: document.querySelector('#chipAction')?.textContent.trim()
  })`);
  check('dirty — chip reports a magnitude, not a state word',
    dirty.l2 === '3 lines differ', JSON.stringify(dirty));
  check('dirty — offers the write, and clean does not (counterfactual)',
    /Save/.test(dirty.action) && clean.action === '',
    `dirty=${JSON.stringify(dirty.action)} clean=${JSON.stringify(clean.action)}`);

  await navigate('problems');
  const invalid = await evaluate(`({
    l1: document.querySelector('#chipL1')?.textContent.trim(),
    action: document.querySelector('#chipAction')?.textContent.trim(),
    pop: !!document.querySelector('.problems, #problemsPop, [data-part="problemsPop"]')
  })`);
  check('invalid — chip counts the problems and offers review',
    /problem/i.test(invalid.l1) && /Review/.test(invalid.action), JSON.stringify(invalid));

  /* ---------------------------------------------------------------------
     2. `Save & run` — the rule that a run executes saved bytes.
     AC #1 names "dirty/Save & run" as a state the prototype must show, and
     TNG89_INTERACTION §1 makes it normative: on a dirty document the submit
     control becomes `Save & run ⌘⇧↵` because there is no run-without-saving.
     So the check is not "does the string exist in the bundle" — it is
     "does the composer present it while the document is dirty".
     --------------------------------------------------------------------- */
  await navigate('compose');
  const composer = await evaluate(`({
    chipL2: document.querySelector('#chipL2')?.textContent.trim(),
    button: document.querySelector('#compAct .btn')?.textContent.trim(),
    allButtons: [...document.querySelectorAll('#compAct .btn')].map((b) => b.textContent.trim())
  })`);
  check('composer — the run screen is reached with a dirty document',
    composer.chipL2 === '3 lines differ', JSON.stringify(composer.chipL2));
  check('dirty/Save & run — dirty composer offers Save & run, not a bare Run',
    /Save & run/.test(composer.allButtons.join(' | ')),
    `chip=${JSON.stringify(composer.chipL2)} buttons=${JSON.stringify(composer.allButtons)}`);

  /* A run started from a dirty document must not leave the document dirty:
     either the control saves first, or the state is unreachable. */
  const afterSubmit = await evaluate(`(() => {
    submitRun('probe goal');
    return {
      phase: run.phase,
      chipL2: document.querySelector('#chipL2')?.textContent.trim()
    };
  })()`);
  check('dirty/Save & run — submitting from dirty does not run unsaved bytes',
    afterSubmit.chipL2 !== '3 lines differ',
    `run started in phase=${afterSubmit.phase} with chip still ${JSON.stringify(afterSubmit.chipL2)}`);

  /* ---------------------------------------------------------------------
     3. Run lifecycle: queued → streaming → complete.
     Driven through the prototype's own model, so the states are the ones a
     reviewer sees rather than hand-set DOM.
     --------------------------------------------------------------------- */
  /* A run started from a dirty document is deliberately not synchronous: the
     write happens first and the run is created against the revision it
     returns, so the probe waits for `queued` instead of asserting it on the
     next tick. Asserting immediately is how this check failed against a
     correct build. */
  await navigate('compose');
  const queued = await evaluate(`(async () => {
    submitRun('Find out how ACP negotiates capabilities.');
    const started = Date.now();
    while (run.phase !== 'queued' && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 40));
    }
    return {
      phase: run.phase,
      text: document.body.innerText,
      chipL2: document.querySelector('#chipL2')?.textContent.trim()
    };
  })()`);
  check('queued — run reports queued and names what it waits for',
    queued.phase === 'queued' && /Queued/i.test(queued.text),
    `phase=${queued.phase}`);
  check('queued — the document was written before the run was created',
    queued.chipL2 !== '3 lines differ', `chip still ${JSON.stringify(queued.chipL2)}`);

  /* `.rt-live, .streaming, [data-state="running"]` matched nothing anywhere in
     this prototype, and the check `||`-ed it with a body-text regex — so the
     dead selector cost nothing and the gate reduced to "the word Running
     appears somewhere", which is also true on `compose`, where no run is in
     flight. The surface that actually reports the phase is `.run-meta`, and it
     says a different word on each of these three screens, so it can fail. */
  /* `innerText` falls back to `textContent` on an element that is not being
     rendered, so reading `.run-meta` directly is a presence check wearing a
     visibility costume — hiding the strip leaves its text readable to the
     probe. Every read of the phase surface goes through this. */
  const shownMeta = `(() => {
    const el = document.querySelector('.run-meta');
    return el && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      ? el.innerText.trim() : '';
  })()`;
  const runMeta = `({
    meta: ${shownMeta},
    phase: typeof run !== 'undefined' ? run.phase : null,
    text: document.body.innerText
  })`;
  await navigate('running');
  const streaming = await evaluate(runMeta);
  check('streaming — live screen reports the run in flight',
    /·\s*running\b/i.test(streaming.meta) && streaming.phase === 'running',
    `run-meta=${JSON.stringify(streaming.meta)} phase=${streaming.phase}`);

  await navigate('trace');
  const complete = await evaluate(runMeta);
  check('complete — finished run reports its duration',
    /Answered in\s+\S/i.test(complete.text), 'no duration followed "Answered in"');
  check('complete — the finished screen reports succeeded, not running (counterfactual)',
    /·\s*succeeded\b/i.test(complete.meta) && !/·\s*running\b/i.test(complete.meta),
    `run-meta=${JSON.stringify(complete.meta)}`);

  /* ---------------------------------------------------------------------
     4. Partial failure — content retained, error verbatim, never hidden.
     --------------------------------------------------------------------- */
  await navigate('answered');
  /* `.rt-body` is the *prompt* body — measuring it instead of the response is
     how a first draft of this probe scored the answer at 67 characters and
     called a healthy screen broken. The answer lives in `.rt-response`. */
  const partial = await evaluate(`({
    strip: !!document.querySelector('.rt-strip.alert'),
    stripText: document.querySelector('.rt-strip.alert')?.innerText || '',
    text: document.body.innerText,
    answerChars: (document.querySelector('.rt-response')?.innerText || '').length
  })`);
  check('partial failure — alert strip present and answer text retained in full',
    partial.strip && /Partial answer/i.test(partial.text) && partial.answerChars > 200,
    `strip=${partial.strip} answerChars=${partial.answerChars}`);
  check('partial failure — the daemon error is verbatim, with its stable code',
    /process_crashed/.test(partial.stripText), JSON.stringify(partial.stripText));
  /* Read the agent row here too. This is the paired half of the "no answer"
     contract below: it proves the selector can *see* a failed agent, so the
     clean row asserted on `unanswered` is a real observation and not an empty
     NodeList quietly satisfying an `every()`. */
  const agentStatesOf = `[...document.querySelectorAll('.node-task b')].map((el) => el.innerText.trim())`;
  const partialAgents = await evaluate(agentStatesOf);
  check('partial failure — the crashed agent reports ERROR in the graph',
    partialAgents.length > 0 && partialAgents.some((s) => /ERROR/i.test(s)),
    JSON.stringify(partialAgents));

  /* ---------------------------------------------------------------------
     4b. Finished, no answer — §3.4's OTHER failure shape.

     This block exists because of TNG-166, which caught the implementation
     reporting a clean run with no answer as `process_crashed`. The spec had
     always separated the two; the prototype had only ever *drawn* the crash,
     so there was no rendered reference to deviate from. The contracts below
     are deliberately counterfactual — it is not enough that the right code
     appears, the crash vocabulary must be absent from the same screen.
     --------------------------------------------------------------------- */
  await navigate('unanswered');
  const visibleAlert = `[...document.querySelectorAll('.rt-strip.alert')]
    .filter((el) => el.offsetParent !== null)`;
  const noAnswer = await evaluate(`({
    stripText: ${visibleAlert}.map((el) => el.innerText).join(' ~ '),
    responseText: document.querySelector('.rt-response')?.innerText || '',
    bodies: document.querySelectorAll('.rt-response .rr-body').length,
    skeletons: document.querySelectorAll('.rt-response .skel-bar').length,
    plain: document.querySelector('.rt-response .rr-plain')?.innerText || '',
    actions: [...document.querySelectorAll('.rt-response .rr-acts button')]
      .map((b) => b.innerText.trim()),
    agentStates: ${agentStatesOf},
    categories: document.querySelectorAll('.rt-chip').length
  })`);
  check('no answer — the run reports missing_canonical_response',
    /missing_canonical_response/.test(noAnswer.stripText), JSON.stringify(noAnswer.stripText));
  check('no answer — it is NOT reported as a crash (counterfactual)',
    !/process_crashed|crashed/i.test(noAnswer.responseText), JSON.stringify(noAnswer.stripText));
  check('no answer — §3.4: failed has no content, so the node is the strip',
    noAnswer.bodies === 0 && noAnswer.skeletons === 0,
    `bodies=${noAnswer.bodies} skeletons=${noAnswer.skeletons}`);
  check('no answer — the plain-language second line is present and additive',
    /finished but no agent produced an answer/i.test(noAnswer.plain)
      && /missing_canonical_response/.test(noAnswer.stripText),
    JSON.stringify(noAnswer.plain));
  check('no answer — Reuse is offered as the action on the node',
    noAnswer.actions.some((t) => /^Reuse$/i.test(t)), JSON.stringify(noAnswer.actions));
  /* The heart of it: nothing crashed. If any agent reported ERROR here the
     screen would be telling the operator to hunt a dead process that never
     existed — the exact wrong answer TNG-166 found in the implementation. */
  check('no answer — every agent exited clean, so the graph shows no error',
    noAnswer.agentStates.length > 0 && noAnswer.agentStates.every((s) => /DONE/i.test(s)),
    JSON.stringify(noAnswer.agentStates));
  check('no answer — a run without an answer still reports its provenance',
    noAnswer.categories === 6, `categories=${noAnswer.categories}`);

  /* ---------------------------------------------------------------------
     5. Reconnect — a transport gap that never rewrites the run state.
     CONTRACT §3.2: reconnection must not be read as pause/cancel. The
     counterfactual is the finished screen, which must carry no gap strip.
     --------------------------------------------------------------------- */
  /* The prototype keeps hidden specimens of the other terminal strips in the
     DOM, so presence proves nothing — only a laid-out strip is on screen.
     Asserting mere presence is what made the counterfactual below fail while
     the screen was correct. */
  const visibleHalt = `[...document.querySelectorAll('.rt-strip.halt')]
    .filter((el) => el.offsetParent !== null)`;
  await navigate('running');
  const gapLive = await evaluate(`({
    halt: ${visibleHalt}.length,
    haltText: ${visibleHalt}.map((el) => el.innerText).join(' ~ '),
    meta: ${shownMeta},
    text: document.body.innerText
  })`);
  check('reconnect — live screen carries a visible transport gap strip',
    gapLive.halt === 1, `visible halt strips = ${gapLive.halt}`);
  check('reconnect — the gap names its watermark rather than saying only "reconnecting"',
    /seq\s*\d+/i.test(gapLive.haltText), JSON.stringify(gapLive.haltText));
  /* The point of this one is that the gap strip does not overwrite the run's
     own phase, so read the phase surface — a body-text regex would be carried
     by the gap strip's own wording. */
  check('reconnect — run indicator still reports the run, not the transport',
    /·\s*running\b/i.test(gapLive.meta), `run-meta=${JSON.stringify(gapLive.meta)}`);
  await navigate('trace');
  const gapDone = await evaluate(`${visibleHalt}.length`);
  check('reconnect — finished run shows no gap strip (counterfactual)',
    gapDone === 0, `finished screen showed ${gapDone} visible halt strips`);

  /* ---------------------------------------------------------------------
     6. Provenance summary — six categories, fixed order.
     Fixed order is the actual requirement (the operator learns positions),
     so the probe asserts the sequence, not the set.
     --------------------------------------------------------------------- */
  await navigate('answered');
  const prov = await evaluate(`(() => {
    const chips = [...document.querySelectorAll('.rt-chip')].map((c) => c.innerText.trim().toLowerCase());
    return { chips, count: chips.length };
  })()`);
  const wantOrder = ['agents', 'reasoning', 'skills', 'tools', 'commands', 'sources'];
  const seen = wantOrder.filter((w) => prov.chips.some((c) => c.includes(w)));
  check('provenance summary — all six contract categories present',
    seen.length === 6, `saw ${JSON.stringify(seen)} in ${JSON.stringify(prov.chips)}`);
  const orderIdx = wantOrder.map((w) => prov.chips.findIndex((c) => c.includes(w)));
  check('provenance summary — categories hold the contract order',
    orderIdx.every((v, i) => i === 0 || (v > orderIdx[i - 1] && v !== -1)),
    JSON.stringify(orderIdx));

  /* ---------------------------------------------------------------------
     7. Expanded trace — one hop at a time, and nothing more.
     The promise is that expanding a category does not explode the graph, so
     the gate is that exactly one category is open and the others contribute
     no entities.
     --------------------------------------------------------------------- */
  /* Two depths exist and they render differently on purpose (prototype.js
     :1427): with a category open the six chips show with one of them `.open`;
     with an *entity* open the chip row is replaced by a breadcrumb, because
     showing both would be two hops on screen at once. The `trace` screen ships
     at the deeper of the two, so gate the depth it is actually in rather than
     assuming the chip row is always present. */
  await navigate('trace');
  const hop = await evaluate(`({
    depth: (typeof run !== 'undefined' && run.openEnt) ? 'entity'
         : (typeof run !== 'undefined' && run.open) ? 'category' : 'none',
    openCats: document.querySelectorAll('.rt-chip.open').length,
    allCats: document.querySelectorAll('.rt-chip').length,
    openEnts: document.querySelectorAll('.ent.open').length,
    entities: document.querySelectorAll('.ent').length,
    crumb: !!document.querySelector('.tray-crumb'),
    back: /Back to response/i.test(document.body.innerText)
  })`);
  check('expanded trace — the screen is at exactly one expansion depth',
    hop.depth === 'entity' || hop.depth === 'category', `depth=${hop.depth}`);
  if (hop.depth === 'entity') {
    check('expanded trace — one entity expanded, and the chip row yields to a breadcrumb',
      hop.openEnts === 1 && hop.allCats === 0 && hop.crumb,
      `openEnts=${hop.openEnts} chips=${hop.allCats} crumb=${hop.crumb}`);
  } else {
    check('expanded trace — exactly one of the six categories is expanded',
      hop.openCats === 1 && hop.allCats === 6,
      `openCats=${hop.openCats} chips=${hop.allCats}`);
  }
  check('expanded trace — the expanded hop renders its entities',
    hop.entities > 0, `entities=${hop.entities}`);
  check('expanded trace — a collapse path back to the response exists', hop.back);

  /* The one-hop rule is a claim about what expansion does *not* do, so drive a
     real category expansion and assert the graph did not explode: the six
     chips stay, exactly one opens, and no second category contributes. */
  await navigate('answered');
  const oneHop = await evaluate(`(() => {
    toggleCat('tools');
    const cats = [...document.querySelectorAll('.rt-chip')];
    return {
      chips: cats.length,
      open: cats.filter((c) => c.classList.contains('open')).map((c) => c.dataset.category),
      label: document.querySelector('.tray-cat-label')?.innerText || '',
      entities: document.querySelectorAll('.ent').length
    };
  })()`);
  check('one hop at a time — expanding a category opens that one and no other',
    oneHop.open.length === 1 && oneHop.open[0] === 'tools',
    `open=${JSON.stringify(oneHop.open)}`);
  check('one hop at a time — the six categories survive the expansion',
    oneHop.chips === 6, `chips=${oneHop.chips}`);
  check('one hop at a time — the opened hop names the edge kind it expanded along',
    /tools/i.test(oneHop.label), JSON.stringify(oneHop.label));

  /* ---------------------------------------------------------------------
     8. Evidence quality — four capture states, three channels each,
     redaction with no reveal affordance (ADR 0005 §7 fails closed).

     `querySelectorAll('.cap-*')` is not a measurement of this screen. The
     prototype ships a hidden specimen gallery — `#system.board`, hidden by the
     screen router, whose `#capRow` and `#capGrey` hold two copies of every
     capture card — so a DOM-wide count reads 2/2/2/2 on *every* screen,
     including `team`, which has no evidence on it at all. Counting that way
     passed while only one of the four states was on screen, and would keep
     passing if the trace screen rendered nothing.

     What a reviewer can actually reach: `recorded` is on the trace screen at
     rest, and the other three ride on entities in specific categories, one
     hop away — `commands` carries derived, `tools` carries unavailable,
     `sources` carries redacted. So drive each hop and assert the state
     becomes *visibly rendered*, not merely present.
     --------------------------------------------------------------------- */
  const visibleCaps = `(() => {
    const shown = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const of = (c) => [...document.querySelectorAll('.cap-' + c)].filter(shown);
    return {
      recorded: of('recorded').length, derived: of('derived').length,
      redacted: of('redacted').length, unavailable: of('unavailable').length,
      redactedText: of('redacted').map((el) => el.innerText),
      unavailableText: of('unavailable').map((el) => el.innerText),
      /* The reason is its own span on the card (\`.e-sub.t-meta\` — \`e.sub\` next to it is
         \`.t-mono-sm\`), so read it directly. Measuring the whole card instead is what made
         the "states a reason" check below unable to fail: a card with the reason deleted
         still carries name, kind, owner and capture word, and was 61 characters. */
      unavailableWhy: of('unavailable')
        .map((el) => el.querySelector('.e-sub.t-meta')?.innerText ?? '')
    };
  })()`;

  await navigate('trace');
  const capRest = await evaluate(visibleCaps);
  check('capture gap — the trace screen shows recorded evidence at rest',
    capRest.recorded > 0, JSON.stringify(capRest));

  /* The counterfactual that makes the three hops below a gate: a screen with
     no evidence on it must score zero. The old DOM-wide count scored 2/2/2/2
     here, which is why it could not fail. */
  await navigate('team');
  const capNone = await evaluate(visibleCaps);
  check('capture gap — a screen with no evidence shows no capture cards (counterfactual)',
    capNone.recorded === 0 && capNone.derived === 0
      && capNone.redacted === 0 && capNone.unavailable === 0,
    JSON.stringify(capNone));

  const capHops = { derived: 'commands', unavailable: 'tools', redacted: 'sources' };
  const capSeen = {};
  for (const [state, category] of Object.entries(capHops)) {
    await navigate('answered');
    capSeen[state] = await evaluate(
      `(() => { toggleCat(${JSON.stringify(category)}); return ${visibleCaps}; })()`);
    check(`capture gap — ${state} evidence renders one hop into ${category}`,
      capSeen[state][state] > 0,
      `${category} showed ${JSON.stringify(capSeen[state])}`);
  }

  /* ADR 0005 §7 fails closed, so this asks the redacted cards a reviewer can
     see whether any of them offers a way through. `.some()` over an empty list
     is `false`, so the population is asserted first — otherwise the check
     passes loudest exactly when redaction has vanished from the screen. */
  const redactedShown = capSeen.redacted.redactedText;
  check('redaction — no hover-to-reveal or request-access affordance on a visible redacted card',
    redactedShown.length > 0
      && !redactedShown.some((t) => /reveal|show bytes|request access|unlock|view source/i.test(t)),
    `${redactedShown.length} visible redacted cards: ${JSON.stringify(redactedShown)}`);

  /* Population first, same as redaction above: `.every()` over an empty list is `true`, so
     this would otherwise pass loudest exactly when `unavailable` has left the screen. */
  const unavailableShown = capSeen.unavailable.unavailableText;
  const unavailableWhy = capSeen.unavailable.unavailableWhy;
  check('capture gap — unavailable evidence states a reason',
    unavailableShown.length > 0 && unavailableWhy.every((t) => t.trim().length > 20),
    `${unavailableShown.length} visible unavailable cards, reasons: ${JSON.stringify(unavailableWhy)}`);

  /* ---------------------------------------------------------------------
     9. Both themes resolve on the run screens specifically. The TNG-87 gate
     covers the system screen; TNG-90's screens are new surfaces and could
     carry a hardcoded value that only shows in one theme.
     --------------------------------------------------------------------- */
  const themeOf = async (hash) => {
    await navigate(hash);
    return evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return {
        theme: document.documentElement.dataset.theme || document.body.dataset.theme,
        ground: cs.getPropertyValue('--color-ground').trim(),
        accent: cs.getPropertyValue('--color-accent').trim(),
        bg: body.backgroundColor
      };
    })()`);
  };
  const darkTrace = await themeOf('trace,dark');
  const lightTrace = await themeOf('trace,light');
  check('themes — dark and light resolve to different grounds on the trace screen',
    darkTrace.ground && lightTrace.ground && darkTrace.ground !== lightTrace.ground,
    `dark=${darkTrace.ground} light=${lightTrace.ground}`);
  check('themes — accent re-resolves per theme (gold vs bronze)',
    darkTrace.accent !== lightTrace.accent,
    `dark=${darkTrace.accent} light=${lightTrace.accent}`);

  /* ---------------------------------------------------------------------
     10. Reduced motion on the streaming screen — the one place motion
     carries meaning, so it is the one place a static fallback must exist.
     --------------------------------------------------------------------- */
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  await navigate('running');
  const motion = await evaluate(`(() => {
    const moving = [...document.querySelectorAll('*')].filter((el) => {
      const cs = getComputedStyle(el);
      return cs.animationName !== 'none' && cs.animationDuration !== '0s'
        && cs.animationIterationCount === 'infinite';
    });
    return { infinite: moving.length, meta: ${shownMeta} };
  })()`);
  check('reduced motion — no infinite animation survives on the live screen',
    motion.infinite === 0, `${motion.infinite} elements still loop`);
  /* "Legible without motion" means the phase is still stated in words once the
     breathing border is gone — which is the phase surface, not any occurrence
     of the word "running" in the page's prose. */
  check('reduced motion — the live state is still legible without motion',
    /·\s*running\b/i.test(motion.meta), `run-meta=${JSON.stringify(motion.meta)}`);
  await send('Emulation.setEmulatedMedia', { features: [] });

  check('no uncaught runtime errors across the TNG-90 screens',
    runtimeErrors.length === 0, runtimeErrors.join(' / '));

} finally {
  try { socket?.close(); } catch {}
  chrome.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

for (const p of passes) console.log(`  ok   ${p}`);
for (const f of failures) console.log(`  FAIL ${f}`);
console.log(`\n${passes.length} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nTNG-90 STATE GATE FAILED');
  process.exit(1);
}
console.log('\nTNG-90 STATE GATE OK — all thirteen named states reachable and asserted');
