#!/usr/bin/env node
/* TNG-90 acceptance probe — the twelve run/provenance states, asserted.
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
  await navigate('compose');
  const queued = await evaluate(`(() => {
    submitRun('Find out how ACP negotiates capabilities.');
    return { phase: run.phase, text: document.body.innerText };
  })()`);
  check('queued — run reports queued and names what it waits for',
    queued.phase === 'queued' && /Queued/i.test(queued.text),
    `phase=${queued.phase}`);

  await navigate('running');
  const streaming = await evaluate(`({
    response: document.body.innerText,
    live: !!document.querySelector('.rt-live, .streaming, [data-state="running"]')
      || /Running|Streaming/i.test(document.body.innerText)
  })`);
  check('streaming — live screen reports the run in flight',
    streaming.live && /Running|Streaming/i.test(streaming.response));

  await navigate('trace');
  const complete = await evaluate(`({ text: document.body.innerText })`);
  check('complete — finished run reports its duration',
    /Answered in/i.test(complete.text));

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
    text: document.body.innerText
  })`);
  check('reconnect — live screen carries a visible transport gap strip',
    gapLive.halt === 1, `visible halt strips = ${gapLive.halt}`);
  check('reconnect — the gap names its watermark rather than saying only "reconnecting"',
    /seq\s*\d+/i.test(gapLive.haltText), JSON.stringify(gapLive.haltText));
  check('reconnect — run indicator still reports the run, not the transport',
    /Running|Streaming/i.test(gapLive.text));
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
     --------------------------------------------------------------------- */
  const capture = await evaluate(`(() => {
    const text = document.body.innerText;
    const cls = (c) => document.querySelectorAll('.cap-' + c).length;
    const redacted = [...document.querySelectorAll('.cap-redacted')];
    const revealish = redacted.some((el) =>
      /reveal|show bytes|request access|unlock|view source/i.test(el.innerText));
    const unavailable = [...document.querySelectorAll('.cap-unavailable')];
    return {
      recorded: cls('recorded'), derived: cls('derived'),
      redacted: cls('redacted'), unavailable: cls('unavailable'),
      revealish,
      unavailableStatesReason: unavailable.every((el) => el.innerText.trim().length > 20),
      words: ['Recorded', 'Derived', 'Redacted', 'Not captured', 'Unavailable']
        .filter((w) => text.includes(w))
    };
  })()`);
  check('capture gap — all four capture states render on the trace screen',
    capture.recorded > 0 && capture.derived > 0 && capture.redacted > 0 && capture.unavailable > 0,
    JSON.stringify(capture));
  check('redaction — no hover-to-reveal or request-access affordance',
    capture.revealish === false);
  check('capture gap — unavailable evidence states a reason',
    capture.unavailableStatesReason, 'an unavailable card carried no reason text');

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
    return { infinite: moving.length, still: /Running|Streaming/i.test(document.body.innerText) };
  })()`);
  check('reduced motion — no infinite animation survives on the live screen',
    motion.infinite === 0, `${motion.infinite} elements still loop`);
  check('reduced motion — the live state is still legible without motion', motion.still);
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
console.log('\nTNG-90 STATE GATE OK — all twelve named states reachable and asserted');
