#!/usr/bin/env node
/* Focused TNG-119 verifier for the generated standalone candidate.
   Drives real keyboard events through headless Chrome; no project install or
   network is required. Set CHROME_BIN when Chrome is not in a standard path. */

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
const profile = await mkdtemp(resolve(scratch, 'loomwatch-tng119-'));

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

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
let socket;
let nextId = 0;
const pending = new Map();
const requests = [];
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
  const page = pages.find((target) => target.type === 'page' && target.url === 'about:blank')
    || pages.find((target) => target.type === 'page');
  if (!page) throw new Error('No inspectable Chrome page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
      if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
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
  await send('Network.enable');
}

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolveCall, reject) => pending.set(id, { resolve: resolveCall, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(detail);
  }
  return result.result.value;
}

async function viewport(width, height) {
  // Exercise the responsive window breakpoint directly. Mobile device-mode
  // adds page-scale emulation that can make a 390 px file:// viewport report
  // a wider CSS layout viewport, which is not the product behavior under test.
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

async function navigate(hash) {
  const key = hash.split(',')[0];
  const url = `${pathToFileURL(artifact).href}#${hash}`;
  await send('Page.navigate', { url });
  // Same-URL navigation fires no hashchange (and the app reloads on
  // hashchange), so force a reload when the document is already there.
  const alreadyThere = await evaluate(`location.href.endsWith(${JSON.stringify('#' + hash)})`).catch(() => false);
  if (alreadyThere) await send('Page.reload');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate(`document.readyState === 'complete'
      && document.querySelector('#stage')?.dataset.screen === ${JSON.stringify(key)}`)
      .catch(() => false);
    if (ready) break;
    await sleep(50);
  }
  await sleep(80);
}

async function key(key, { code = key, modifiers = 0, virtualKeyCode = 0 } = {}) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: virtualKeyCode, text: key.length === 1 ? key : undefined });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtualKeyCode });
  await sleep(60);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

try {
  await connect();
  await viewport(1600, 1000);

  await navigate('answered,dark');
  const answeredReady = await evaluate("({href:location.href, screen:document.querySelector('#stage')?.dataset.screen, nodes:document.querySelectorAll('[data-node]').length, overlay:document.querySelector('#overlay')?.childElementCount})");
  assert(answeredReady.nodes > 0, `Answered screen did not render nodes: ${JSON.stringify(answeredReady)}`);
  const causalStory = await evaluate(`(() => {
    const overlay = document.querySelector('#overlay');
    const labels = [...overlay.querySelectorAll('.story-label')].map((node) => node.textContent.trim());
    return {
      prompt: overlay.querySelector('.story-prompt')?.textContent,
      run: overlay.querySelector('.run-node')?.textContent,
      agentA: overlay.querySelector('.story-agent-a')?.textContent,
      agentB: overlay.querySelector('.story-agent-b')?.textContent,
      output: overlay.querySelector('.story-output')?.textContent,
      evidence: overlay.querySelectorAll('.story-evidence').length,
      evidenceText: [...overlay.querySelectorAll('.story-evidence')].map((node) => node.textContent).join(' '),
      notion: overlay.querySelector('[data-activity="la1"]')?.textContent,
      storyEdges: document.querySelectorAll('#provGroup .story-edge').length,
      labels
    };
  })()`);
  assert(/Prompt · user request/.test(causalStory.prompt) && /Original kept/.test(causalStory.prompt), `Durable Prompt node is missing: ${JSON.stringify(causalStory)}`);
  assert(/Run 01/.test(causalStory.run) && /Initiating branch/.test(causalStory.run), `Explicit initiating Run node is missing: ${JSON.stringify(causalStory)}`);
  assert(/Agent A · lead/.test(causalStory.agentA) && /Agent B · responder/.test(causalStory.agentB), `Lead/responder ownership is missing: ${JSON.stringify(causalStory)}`);
  assert(/Output \/ response · Agent B/.test(causalStory.output), `Explicit terminal output ownership is missing: ${JSON.stringify(causalStory)}`);
  assert(causalStory.evidence === 7 && /Notion/.test(causalStory.notion) && /knowledge search/.test(causalStory.evidenceText) && /repository/.test(causalStory.evidenceText) && /external source/.test(causalStory.evidenceText) && /release-evidence/.test(causalStory.evidenceText) && /file/.test(causalStory.evidenceText) && /sanitized command/.test(causalStory.evidenceText) && causalStory.storyEdges >= 5, `Agent-owned evidence path is incomplete: ${JSON.stringify(causalStory)}`);
  assert(causalStory.labels.some((label) => /starts/.test(label)) && causalStory.labels.some((label) => /assigns lead/.test(label)) && causalStory.labels.some((label) => /delegates review/.test(label)) && causalStory.labels.some((label) => /responds with/.test(label)), `Named directional story edges are incomplete: ${JSON.stringify(causalStory)}`);
  await evaluate("document.querySelector('[data-node=\"n1\"]').focus()");
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  const nodeOpened = await evaluate("({hidden:document.querySelector('#inspector').hidden, active:document.activeElement.outerHTML.slice(0,160), selected:document.querySelector('[data-node=\"n1\"]')?.getAttribute('aria-expanded')})");
  assert(!nodeOpened.hidden && nodeOpened.selected === 'true' && /data-node=/.test(nodeOpened.active), `Enter did not open the node inspector with stable focus: ${JSON.stringify(nodeOpened)}`);
  await key('Escape', { code: 'Escape', virtualKeyCode: 27 });
  const nodeClosed = await evaluate("({hidden:document.querySelector('#inspector').hidden, active:document.activeElement.outerHTML.slice(0,160), node:document.querySelector('[data-node=\"n1\"]')?.outerHTML.slice(0,100)})");
  assert(nodeClosed.hidden && /data-node=/.test(nodeClosed.active), `Node inspector dismissal did not restore focus: ${JSON.stringify(nodeClosed)}`);

  await navigate('running,dark');
  await evaluate("document.documentElement.dataset.motion = 'reduce'");
  const reducedLive = await evaluate("(() => { const node = document.querySelector('.story-agent-a'); const css = getComputedStyle(node); return {animation:css.animationName, border:css.borderWidth, label:node.textContent}; })()");
  assert(reducedLive.animation === 'none' && reducedLive.border === '2px' && /RUNNING|STREAMING/.test(reducedLive.label), `Reduced-motion running state lost its static blue treatment: ${JSON.stringify(reducedLive)}`);
  await evaluate("document.querySelector('[data-activity=\"la1\"]').focus(); document.querySelector('#stage').scrollTop = 0");
  await key(' ', { code: 'Space', virtualKeyCode: 32 });
  assert(await evaluate("!document.querySelector('#activityPanel').hidden && document.activeElement.id === 'activityClose' && document.querySelector('#stage').scrollTop === 0"), 'Space did not inspect live activity without scrolling');
  await key('Escape', { code: 'Escape', virtualKeyCode: 27 });
  assert(await evaluate("document.querySelector('#activityPanel').hidden && document.activeElement.dataset.activity === 'la1'"), 'Activity panel dismissal did not restore card focus');

  await navigate('answered,dark');
  await evaluate("document.querySelector('#runtimeResponse').focus(); document.querySelector('#stage').scrollTop = 0");
  await key(' ', { code: 'Space', virtualKeyCode: 32 });
  assert(await evaluate("document.querySelector('#runtimeResponse').getAttribute('aria-expanded') === 'false' && document.activeElement.id === 'runtimeResponse' && document.querySelector('#stage').scrollTop === 0"), 'Space did not collapse terminal response provenance with stable focus');
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  assert(await evaluate("document.querySelector('#runtimeResponse').getAttribute('aria-expanded') === 'true'"), 'Enter did not expand terminal response provenance');

  await evaluate("document.querySelector('[data-category=\"tools\"]').focus()");
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  assert(await evaluate("document.querySelector('[data-category=\"tools\"]').getAttribute('aria-expanded') === 'true' && document.activeElement.dataset.category === 'tools'"), 'Provenance category did not expand with stable focus');
  await key(' ', { code: 'Space', virtualKeyCode: 32 });
  assert(await evaluate("document.querySelector('[data-category=\"tools\"]').getAttribute('aria-expanded') === 'false' && document.activeElement.dataset.category === 'tools'"), 'Provenance category did not collapse with Space');

  await evaluate("document.querySelector('[data-filter-cat=\"skills\"]').focus()");
  await key(' ', { code: 'Space', virtualKeyCode: 32 });
  assert(await evaluate("document.querySelector('[data-filter-cat=\"skills\"]').getAttribute('aria-pressed') === 'false' && document.activeElement.dataset.filterCat === 'skills'"), 'Filter state/focus did not survive rerender');

  await navigate('answered,dark');
  await evaluate("[...document.querySelectorAll('#compAct button')].find((button) => /Retry/.test(button.textContent)).click()");
  const retryBranch = await evaluate("({run:document.querySelector('.run-node')?.textContent, prior:document.querySelector('#priorBranch')?.textContent, prompt:document.querySelector('.story-prompt')?.textContent, expanded:document.querySelector('#priorBranch')?.getAttribute('aria-expanded')})");
  assert(/Run 02/.test(retryBranch.run) && /Previous branch · Run 01/.test(retryBranch.prior) && /evidence kept/.test(retryBranch.prior) && /Review the ACP spine/.test(retryBranch.prompt), `Retry did not preserve input/evidence in a distinguishable branch: ${JSON.stringify(retryBranch)}`);
  await evaluate("clearTimers()");

  await viewport(390, 844);
  for (const theme of ['dark', 'light']) {
    await navigate(`answered,${theme}`);
    await evaluate("SEEDS.answered(); paintRun()");
    const narrow = await evaluate(`(() => {
      const stage = document.querySelector('#stage');
      const response = document.querySelector('#runtimeResponse');
      const composer = document.querySelector('#composer');
      const themeButton = document.querySelector('#themeBtn');
      const themeRect = themeButton.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const themeHit = document.elementFromPoint(themeRect.left + themeRect.width / 2, themeRect.top + themeRect.height / 2);
      return {
        layout: document.documentElement.dataset.layout,
        theme: document.documentElement.dataset.theme,
        transform: getComputedStyle(stage).transform,
        responseFont: getComputedStyle(response.querySelector('.rr-body')).fontSize,
        responseClass: response.querySelector('.rr-body').className,
        responseText: response.querySelector('.rr-body').textContent.slice(0, 40),
        themeTarget: themeButton.getBoundingClientRect().height,
        themeDisplay: getComputedStyle(themeButton).display,
        themeParentDisplay: getComputedStyle(themeButton.parentElement).display,
        themeTop: themeRect.top,
        themeRight: themeRect.right,
        themeHit: themeHit?.closest('button')?.id || themeHit?.id || '',
        composerWidth: composerRect.width,
        composerBottom: composerRect.bottom,
        stageWidth: stage.clientWidth,
        viewportHeight: innerHeight,
        overflow: stage.scrollWidth - stage.clientWidth
      };
    })()`);
    assert(narrow.layout === 'narrow' && narrow.theme === theme, `${theme} narrow mode did not initialize`);
    assert(narrow.transform === 'none', `${theme} narrow mode still scales the stage`);
    assert(narrow.responseFont === '14px', `${theme} narrow response text was scaled: ${JSON.stringify(narrow)}`);
    assert(narrow.themeTarget >= 44 && narrow.themeDisplay !== 'none' && narrow.themeParentDisplay !== 'none' && narrow.themeTop >= 82 && narrow.themeRight <= 390 && narrow.themeHit === 'themeBtn', `${theme} narrow theme control is not visible/reachable: ${JSON.stringify(narrow)}`);
    assert(narrow.composerWidth <= narrow.stageWidth && narrow.overflow <= 1, `${theme} narrow composition overflows horizontally`);
    assert(narrow.composerBottom <= narrow.viewportHeight && narrow.composerBottom >= narrow.viewportHeight - 16, `${theme} narrow composer is not viewport-docked`);
  }

  await navigate('compose,dark');
  await evaluate("document.querySelector('#compInput').focus()");
  await key('Enter', { code: 'Enter', modifiers: 2, virtualKeyCode: 13 });
  assert(await evaluate("document.querySelector('#runtimeResponse')?.getAttribute('role') === 'status' && /Queued/.test(document.querySelector('#runtimeResponse').getAttribute('aria-label'))"), 'Keyboard prompt submission did not land a queued response');

  await navigate('running,dark');
  await evaluate("[...document.querySelectorAll('#compAct button')].find((button) => button.textContent.trim() === 'Stop').click()");
  assert(await evaluate("/Cancelled/.test(document.querySelector('#runtimeResponse').textContent) && [...document.querySelectorAll('#compAct button')].some((button) => /Retry/.test(button.textContent))"), 'Narrow cancel/retry state did not remain available');

  assert(runtimeErrors.length === 0, `Standalone emitted runtime exceptions: ${JSON.stringify(runtimeErrors)}`);
  assert(requests.every((url) => url.startsWith('file:') || url.startsWith('data:')), `Standalone attempted a network request: ${JSON.stringify(requests)}`);

  /* =====================================================================
     TNG-121 — editable live pipeline: palette drag + keyboard placement,
     valid-drop state, focus behavior, bounded overflow, both themes.
     ===================================================================== */
  await viewport(1600, 1000);
  await navigate('compose,dark');
  const paletteReady = await evaluate(`(() => ({
    panel: !document.querySelector('#palettePanel')?.hidden,
    rows: document.querySelectorAll('#palettePanel [data-palette]').length,
    nodes: document.querySelectorAll('#overlay [data-node]').length,
    count: document.querySelector('#ppCount')?.textContent
  }))()`);
  assert(paletteReady.rows === 5 && paletteReady.nodes === 2 && paletteReady.count === '5 available',
    `Available-team palette did not initialize over the live pipeline: ${JSON.stringify(paletteReady)}`);

  // Pointer path: real dragstart → dragover → drop wiring, with a real DataTransfer.
  const dropResult = await evaluate(`(() => {
    const row = document.querySelector('[data-palette="reviewer"]');
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const slot = document.querySelector('[data-slot="0"]');
    const armedVisible = !!slot;
    slot.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const validState = slot.classList.contains('drop-ok');
    slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const nodes = [...document.querySelectorAll('#overlay [data-node]')].map((n) => n.dataset.node);
    return { armedVisible, validState, nodes, label: document.querySelector('#compModeLabel')?.textContent };
  })()`);
  assert(dropResult.armedVisible && dropResult.validState, `Drag did not show an unambiguous slot with a valid-drop state: ${JSON.stringify(dropResult)}`);
  assert(dropResult.nodes.length === 3 && /Pipeline · 3 steps/.test(dropResult.label),
    `Drop did not insert the agent and update the graph: ${JSON.stringify(dropResult)}`);
  await sleep(120);
  const dropFocus = await evaluate(`(() => ({ nodes: [...document.querySelectorAll('#overlay [data-node]')].map((n) => n.dataset.node),
    focus: document.activeElement?.dataset?.node }))()`);
  assert(dropFocus.nodes[1]?.startsWith('ins') && dropFocus.focus === dropFocus.nodes[1],
    `Inserted agent did not land in the flow and take focus: ${JSON.stringify(dropFocus)}`);
  const flowIntact = await evaluate(`(() => {
    document.querySelector('#compInput').value = 'Find out how ACP negotiates capabilities.';
    submitRun();
    clearTimers();
    const labels = [...document.querySelectorAll('.story-label, .prov-label')].map((l) => l.textContent.trim());
    const agentCards = [...document.querySelectorAll('#overlay [data-node]')].map((n) => n.textContent);
    return { delegates: labels.filter((t) => t === 'delegates review').length,
             responder: agentCards[agentCards.length - 1] || '' };
  })()`);
  assert(flowIntact.delegates === 2 && /Agent B · responder/.test(flowIntact.responder),
    `Prompt-to-output flow does not pass through the inserted agent: ${JSON.stringify(flowIntact)}`);

  // Keyboard path: arm from the palette, Tab between slots, Esc cancels with focus restore.
  await navigate('compose,dark');
  await evaluate("document.querySelector('[data-palette=\"opencode\"]').focus()");
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  const armedState = await evaluate(`(() => ({
    slots: document.querySelectorAll('#overlay [data-slot]').length,
    focus: document.activeElement?.dataset?.slot,
    label: document.querySelector('[data-slot="0"]')?.getAttribute('aria-label')
  }))()`);
  assert(armedState.slots === 1 && armedState.focus === '0' && /Insert opencode/.test(armedState.label),
    `Enter did not arm placement with a focused slot: ${JSON.stringify(armedState)}`);
  await key('Escape', { code: 'Escape', virtualKeyCode: 27 });
  const cancelled = await evaluate(`(() => ({ slots: document.querySelectorAll('#overlay [data-slot]').length,
    focus: document.activeElement?.dataset?.palette }))()`);
  assert(cancelled.slots === 0 && cancelled.focus === 'opencode', `Esc did not cancel placement and restore focus: ${JSON.stringify(cancelled)}`);
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  const kbInsert = await evaluate(`(() => ({
    nodes: [...document.querySelectorAll('#overlay [data-node]')].map((n) => n.dataset.node),
    focus: document.activeElement?.dataset?.node,
    announce: document.querySelector('#liveRegion')?.textContent
  }))()`);
  assert(kbInsert.nodes.length === 3 && kbInsert.focus === kbInsert.nodes[1],
    `Keyboard slot activation did not insert and focus the new step: ${JSON.stringify(kbInsert)}`);

  // Overflow probes — desktop, both themes: bounded cards, no page overflow,
  // no collisions between the provenance tray, prior branch and palette.
  for (const theme of ['dark', 'light']) {
    await navigate(`answered,${theme}`);
    // The answered seed already has provenance expanded (run.selected).
    await evaluate("SEEDS.answered(); paintRun()");
    const bounded = await evaluate(`(() => {
      const stage = document.querySelector('#stage');
      const tray = document.querySelector('#provTray');
      const prior = document.querySelector('#priorBranch');
      const prompt = document.querySelector('.story-prompt');
      const resp = document.querySelector('#runtimeResponse');
      const palette = document.querySelector('#palettePanel');
      const overlaps = (a, b) => a && b && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const clipped = [...document.querySelectorAll('.activity-ent, .rt-response .rr-head, .story-prompt .rt-head')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1).length;
      return {
        stageOverflowX: stage.scrollWidth - stage.clientWidth,
        stageBottom: stage.getBoundingClientRect().bottom,
        trayRect: tray ? { top: tray.getBoundingClientRect().top, bottom: tray.getBoundingClientRect().bottom, height: tray.getBoundingClientRect().height } : null,
        priorRect: prior ? { top: prior.getBoundingClientRect().top, bottom: prior.getBoundingClientRect().bottom, left: prior.getBoundingClientRect().left } : null,
        priorTrayOverlap: overlaps(prior?.getBoundingClientRect(), tray?.getBoundingClientRect()),
        paletteRespOverlap: overlaps(palette?.getBoundingClientRect(), resp.getBoundingClientRect()),
        promptBounded: prompt.querySelector('.rt-body').scrollHeight <= prompt.querySelector('.rt-body').clientHeight + 2 || prompt.querySelector('.rt-body').clientHeight <= 132,
        clipped
      };
    })()`);
    assert(bounded.stageOverflowX <= 1 && bounded.clipped === 0,
      `${theme} desktop has overflowing node text: ${JSON.stringify(bounded)}`);
    assert(bounded.trayRect && bounded.trayRect.bottom <= bounded.stageBottom && bounded.trayRect.top >= 0 && !bounded.priorTrayOverlap,
      `${theme} desktop provenance tray overflows the stage or collides with the prior branch: ${JSON.stringify(bounded)}`);
    assert(!bounded.paletteRespOverlap, `${theme} desktop palette overlaps the response card: ${JSON.stringify(bounded)}`);

    // Narrow: tray stays in the column, no horizontal overflow, theme reachable.
    await viewport(390, 844);
    await navigate(`answered,${theme}`);
    await evaluate("SEEDS.answered(); paintRun()");
    const narrowTray = await evaluate(`(() => {
      const stage = document.querySelector('#stage');
      const tray = document.querySelector('#provTray');
      return { layout: document.documentElement.dataset.layout,
        overflow: stage.scrollWidth - stage.clientWidth,
        trayWidth: tray?.getBoundingClientRect().width,
        stageWidth: stage.clientWidth };
    })()`);
    assert(narrowTray.layout === 'narrow' && narrowTray.overflow <= 1 && narrowTray.trayWidth <= 390,
      `${theme} narrow provenance tray overflows the column: ${JSON.stringify(narrowTray)}`);
    await viewport(1600, 1000);
  }

  // Historical-run UI: rows clip long goals inside the popover; replay stays locked.
  await navigate('answered,dark');
  await evaluate("openHistory()");
  const histOverflow = await evaluate(`[...document.querySelectorAll('#history .pop-row')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1).length`);
  assert(histOverflow === 0, `Run history rows overflow their rows: ${histOverflow}`);
  await key('Escape', { code: 'Escape', virtualKeyCode: 27 });

  assert(runtimeErrors.length === 0, `Standalone emitted runtime exceptions: ${JSON.stringify(runtimeErrors)}`);
  assert(requests.every((url) => url.startsWith('file:') || url.startsWith('data:')), `Standalone attempted a network request: ${JSON.stringify(requests)}`);

  console.log('TNG-119 + TNG-121 verification passed: causal graph, editable pipeline (drag + keyboard), interaction, overflow bounds, themes, narrow layout, reduced motion, retry retention, and offline loading');
} finally {
  if (socket) socket.close();
  await new Promise((resolveExit) => {
    if (chrome.exitCode !== null) return resolveExit();
    chrome.once('exit', resolveExit);
    chrome.kill('SIGTERM');
  });
  await rm(profile, { recursive: true, force: true });
}
