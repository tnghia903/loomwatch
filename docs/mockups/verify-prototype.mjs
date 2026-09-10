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
  /* The app reloads on hashchange, so same-URL navigations can race the
     previous document's teardown; retry the navigation once on a transient
     CDP detach instead of failing the run. */
  for (let navAttempt = 0; navAttempt < 2; navAttempt += 1) {
    try {
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
      await sleep(120);
      return;
    } catch (err) {
      if (navAttempt === 1) throw err;
      await sleep(300);
    }
  }
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

  /* =====================================================================
     TNG-122 — freeform placement, typed wiring, capability library,
     keyboard parity, planned-vs-observed separation, themes, narrow.
     ===================================================================== */
  await viewport(1600, 1000);
  await navigate('wiring,dark');
  const wireReady = await evaluate(`(() => ({
    screen: document.querySelector('#stage').dataset.screen,
    planned: document.querySelectorAll('#edgeGroup .warp').length,
    libRows: document.querySelectorAll('#libGroups .lib-row').length,
    usableRows: document.querySelectorAll('#libGroups .lib-row[data-res]').length,
    foot: document.querySelector('#libFootCount').textContent,
    hidden: document.querySelector('#libFootHidden').textContent,
    strip: !!document.querySelector('#wireStrip'),
    counts: document.querySelector('#wireCounts')?.textContent
  }))()`);
  assert(wireReady.screen === 'wiring' && wireReady.planned === 6, `Wiring screen did not initialize: ${JSON.stringify(wireReady)}`);
  assert(wireReady.strip && /Planned 6/.test(wireReady.counts), `Wire strip missing or wrong counts: ${JSON.stringify(wireReady)}`);
  const desktopComposition = await evaluate(`(() => {
    const lib = document.querySelector('#library').getBoundingClientRect();
    const prompt = document.querySelector('[data-wnode="wp1"]').getBoundingClientRect();
    const lead = document.querySelector('[data-node="wa1"]').getBoundingClientRect();
    const labels = [...document.querySelectorAll('#edgeLabels .rel-word')].map((n) => n.textContent.trim());
    return { libRight: lib.right, promptLeft: prompt.left, leadLeft: lead.left, labels,
      promptHandle: document.querySelectorAll('[data-wnode="wp1"] .handle.r').length };
  })()`);
  assert(desktopComposition.promptLeft > desktopComposition.libRight && desktopComposition.leadLeft > desktopComposition.libRight,
    `Library obscures the prompt-to-output origin: ${JSON.stringify(desktopComposition)}`);
  for (const relation of ['starts', 'hands off', 'uses skill', 'invokes', 'reads', 'produces'])
    assert(desktopComposition.labels.includes(relation), `Seed graph does not demonstrate ${relation}: ${JSON.stringify(desktopComposition.labels)}`);
  assert(desktopComposition.promptHandle === 1, `Prompt origin has no pointer wiring handle: ${JSON.stringify(desktopComposition)}`);
  /* expand every collapsed group, then the full catalogue is in the DOM */
  await evaluate(`RES_GROUPS.forEach((g) => { g.collapsed = false; }); renderLibrary();`);
  const expanded = await evaluate(`({ rows: document.querySelectorAll('#libGroups .lib-row').length,
    usable: document.querySelectorAll('#libGroups .lib-row[data-res]').length,
    groups: document.querySelectorAll('#libGroups .lib-group').length })`);
  assert(expanded.rows === 20 && expanded.usable === 16 && expanded.groups === 4, `Library catalogue wrong: ${JSON.stringify(expanded)}`);
  assert(/2 hidden by workspace policy/.test(wireReady.hidden), `Hidden-resource boundary not stated: ${JSON.stringify(wireReady)}`);

  /* library: search, category filter, state filter, collapsed group, empty state */
  await evaluate(`(() => { const i = document.querySelector('#libSearch'); i.value = 'notion'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const searched = await evaluate(`({ names: [...document.querySelectorAll('#libGroups .lib-row-name')].map((n) => n.textContent.trim()), foot: document.querySelector('#libFootCount').textContent })`);
  assert(searched.names.length === 2 && searched.names.every((n) => /Notion/.test(n)), `Library search failed: ${JSON.stringify(searched)}`);
  await evaluate(`(() => { const i = document.querySelector('#libSearch'); i.value = 'zzzz-nothing'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const emptyState = await evaluate(`({ foot: document.querySelector('#libFootCount').textContent, empties: document.querySelectorAll('#libGroups .lib-empty').length })`);
  assert(/No resources match/.test(emptyState.foot) && emptyState.empties === 4, `Library empty state missing: ${JSON.stringify(emptyState)}`);
  await evaluate(`(() => { const i = document.querySelector('#libSearch'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`(() => { const b = document.querySelector('[data-lf="status"][data-v="disconnected"]'); b.click(); })()`);
  const disconnectedOnly = await evaluate(`({ rows: [...document.querySelectorAll('#libGroups .lib-row')].length,
    names: [...document.querySelectorAll('#libGroups .lib-row-name')].map((n) => n.textContent.trim()),
    usable: [...document.querySelectorAll('#libGroups .lib-row[data-res]')].length })`);
  assert(disconnectedOnly.rows === 3 && disconnectedOnly.usable === 0, `Disconnected filter wrong: ${JSON.stringify(disconnectedOnly)}`);
  await evaluate(`document.querySelector('[data-lf="status"][data-v="all"]').click()`);

  /* TNG-125: the grab affordance is a resting fact, not a hover reveal. The
     rejection this baseline answers was literally "I cannot drag and drop
     everything in the library sidebar", so a handle that only exists under the
     pointer does not count — and on touch it never appears at all. */
  const restingGrab = await evaluate(`(() => {
    const usable = [...document.querySelectorAll('#libGroups .lib-row[data-res]')];
    const unusable = [...document.querySelectorAll('#libGroups .lib-row.unavailable')];
    const dots = usable.map((r) => r.querySelector('.drag-dots')).filter(Boolean);
    return { usable: usable.length, withDots: dots.length,
      unusableWithDots: unusable.filter((r) => r.querySelector('.drag-dots')).length,
      opacity: dots.length ? Number(getComputedStyle(dots[0]).opacity) : 0,
      draggable: usable.every((r) => r.getAttribute('draggable') === 'true') };
  })()`);
  assert(restingGrab.usable === 16 && restingGrab.withDots === restingGrab.usable,
    `Not every draggable library row carries a grab handle: ${JSON.stringify(restingGrab)}`);
  /* .75 on ink-3 was measured at 3.26:1 (dark) / 3.24:1 (light) against the
     composited row fill — the 3:1 non-text floor with a little headroom. Any
     drop below .75 puts the resting affordance back under the bar. */
  assert(restingGrab.opacity >= 0.75, `Grab handle is not legible at rest: ${JSON.stringify(restingGrab)}`);
  assert(restingGrab.unusableWithDots === 0, `Unusable rows advertise a drag they would refuse: ${JSON.stringify(restingGrab)}`);
  assert(restingGrab.draggable, `Rows carrying a grab handle are not actually draggable: ${JSON.stringify(restingGrab)}`);

  /* TNG-127: a visible, draggable handle is still not a drag if the browser
     decides the gesture was a text selection. In WebKit, pressing on selectable
     text inside a draggable="true" element starts a selection and the drag never
     arms — which is what the board hit ("It is highlighting the texts instead").
     Chromium prefers the drag, so this harness cannot reproduce the failure by
     gesture; it asserts the *invariant* that prevents it instead.

     One trap worth recording: a computed-style check on the draggable rows
     themselves proves nothing here. Chromium's UA stylesheet already forces
     user-select: none on [draggable="true"] and its descendants, so those
     elements report "none" even with every author rule deleted — measured, not
     assumed. WebKit has no such UA rule, which is the whole bug. So the checks
     below deliberately target what is genuinely author-driven: the shell and
     the non-draggable canvas labels (both verified to fail without the fix),
     plus the declaration itself via CSSOM and the shipped bytes. */
  const selectability = await evaluate(`(() => {
    const sel = (el) => getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect;
    const optIns = ['.rr-body', '.ent-out', '.story-prompt .rt-body', '.cite', '.input', 'input', 'textarea']
      .flatMap((q) => [...document.querySelectorAll('#stage ' + q)]);
    let declared = null;
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules || []) {
        if (rule.selectorText === '#stage' && rule.style.getPropertyValue('user-select')) {
          declared = rule.style.getPropertyValue('user-select');
        }
      }
    }
    return {
      stage: sel(document.querySelector('#stage')),
      declared,
      prefixedInBytes: document.documentElement.outerHTML.includes('-webkit-user-select: none'),
      libraryText: [...document.querySelectorAll('#libGroups .lib-row-name, #libGroups .lib-row-sub')]
        .filter((n) => sel(n) !== 'none').length,
      nodeLabels: [...document.querySelectorAll('#nodes .w-top, #nodes .n-title')].filter((n) => sel(n) !== 'none').length,
      optIns: optIns.length,
      lockedOptIns: optIns.filter((el) => sel(el) === 'none').length };
  })()`);
  assert(selectability.stage === 'none',
    `App shell is text-selectable, so a drag smears a selection across it instead of dragging: ${JSON.stringify(selectability)}`);
  assert(selectability.declared === 'none',
    `No author rule locks selection on #stage — Chromium's UA sheet would hide this, WebKit will not: ${JSON.stringify(selectability)}`);
  assert(selectability.prefixedInBytes,
    `The -webkit-user-select fallback was stripped from the shipped bytes: ${JSON.stringify(selectability)}`);
  assert(selectability.libraryText === 0,
    `Library row text is selectable, so pressing a row label starts a selection: ${JSON.stringify(selectability)}`);
  assert(selectability.nodeLabels === 0,
    `Canvas node labels are selectable, so dragging a node smears a selection: ${JSON.stringify(selectability)}`);
  /* The inverse: locking the shell must not cost the user the ability to copy
     the answer, command output, their own prompt, or to edit a field at all. */
  assert(selectability.optIns > 0 && selectability.lockedOptIns === 0,
    `Real content lost its selectability — the answer/output/fields cannot be copied: ${JSON.stringify(selectability)}`);

  /* freeform keyboard placement from the library: Enter arms, arrows move, Enter drops */
  await evaluate(`document.querySelector('[data-res="r-tool-bus"]').focus()`);
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  const armedPlace = await evaluate(`({ placing: !!wiring.placing, ctx: document.querySelector('#wireContext').textContent })`);
  assert(armedPlace.placing && /Placing Team Bus/.test(armedPlace.ctx), `Library Enter did not arm freeform placement: ${JSON.stringify(armedPlace)}`);
  await key('ArrowRight', { code: 'ArrowRight', virtualKeyCode: 39 });
  await key('ArrowDown', { code: 'ArrowDown', virtualKeyCode: 40 });
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  const placed = await evaluate(`({ n: wiring.nodes.length, last: wiring.nodes[wiring.nodes.length - 1], focus: document.activeElement?.dataset?.wnode || document.activeElement?.dataset?.node })`);
  assert(placed.n === 9 && placed.last.ref === 'r-tool-bus' && (placed.focus === placed.last.id), `Keyboard placement did not drop at the ghost position with focus: ${JSON.stringify(placed)}`);

  /* TNG-125: the remaining legs of that path — the armed row must say it is the
     source (a ghost alone cannot, with 20 similar rows), and Escape must cancel
     and hand focus back to the row it was armed from. No dead affordances: the
     .lib-row-arming style is asserted as *computed*, because scoped under
     #library the unscoped form would lose on specificity and render nothing. */
  const armSource = await evaluate(`(() => {
    const row = document.querySelector('#libGroups .lib-row[data-res]');
    row.focus();
    return row.dataset.res;
  })()`);
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  const armingStyle = await evaluate(`(() => {
    const armed = document.querySelector('#libGroups .lib-row.lib-row-arming');
    const plain = [...document.querySelectorAll('#libGroups .lib-row[data-res]')]
      .find((n) => !n.classList.contains('lib-row-arming'));
    if (!armed || !plain) return { armed: !!armed, plain: !!plain };
    const a = getComputedStyle(armed);
    const p = getComputedStyle(plain);
    return { armed: true, plain: true, res: armed.dataset.res,
      border: a.borderTopColor, plainBorder: p.borderTopColor,
      shadow: a.boxShadow, plainShadow: p.boxShadow,
      bg: a.backgroundColor, plainBg: p.backgroundColor,
      label: armed.getAttribute('aria-label') };
  })()`);
  assert(armingStyle.armed && armingStyle.plain, `Arming did not mark its library source row: ${JSON.stringify(armingStyle)}`);
  assert(armingStyle.res === armSource, `Arming marked the wrong library row: ${JSON.stringify(armingStyle)}`);
  assert(armingStyle.border !== armingStyle.plainBorder && armingStyle.bg !== armingStyle.plainBg,
    `Armed library row is not visually distinct from a resting row: ${JSON.stringify(armingStyle)}`);
  assert(/inset/.test(armingStyle.shadow) && !/inset/.test(armingStyle.plainShadow),
    `Armed library row lost its status rail: ${JSON.stringify(armingStyle)}`);
  assert(/armed for placement/.test(armingStyle.label), `Armed row does not announce its state: ${JSON.stringify(armingStyle)}`);
  await key('Escape', { code: 'Escape', virtualKeyCode: 27 });
  const placementCancelled = await evaluate(`({ placing: !!wiring.placing,
    arming: document.querySelectorAll('#libGroups .lib-row.lib-row-arming').length,
    focus: document.activeElement?.dataset?.res,
    nodes: wiring.nodes.length })`);
  assert(!placementCancelled.placing && placementCancelled.arming === 0, `Escape did not cancel the armed placement: ${JSON.stringify(placementCancelled)}`);
  assert(placementCancelled.focus === armSource, `Escape did not return focus to the source row: ${JSON.stringify(placementCancelled)}`);
  assert(placementCancelled.nodes === 9, `Cancelled placement still dropped a node: ${JSON.stringify(placementCancelled)}`);
  /* cancel deliberately parks focus on the library row, so hand the suite back
     the canvas focus it had before this block or the next Enter re-arms here */
  await evaluate(`document.querySelector('[data-wnode="${placed.last.id}"]').focus()`);

  /* unusable resource: refused with explanation, nothing placed */
  const refusedPlace = await evaluate(`({ ok: !!placeResource('r-skill-sql', 400, 400), notice: document.querySelector('#wireNotice').textContent })`);
  assert(!refusedPlace.ok && /Disconnected|can't be placed/.test(refusedPlace.notice), `Disconnected resource was placeable or unexplained: ${JSON.stringify(refusedPlace)}`);

  /* typed wiring by keyboard: select codex, W arms, Tab cycles with narration, Enter commits */
  await evaluate(`selectWire('wa3')`);
  await key('w', { code: 'KeyW', virtualKeyCode: 87 });
  const armedWire = await evaluate(`({ armed: !!wiring.armed, from: wiring.armed?.from })`);
  assert(armedWire.armed && armedWire.from === 'wa3', `W did not arm wiring: ${JSON.stringify(armedWire)}`);
  const narrated = await evaluate(`document.querySelector('#wireContext').textContent`);
  assert(/Wiring from codex/.test(narrated), `Wiring arm was not reflected in the strip: ${narrated}`);
  await key('Tab', { code: 'Tab', virtualKeyCode: 9 });
  await key('Tab', { code: 'Tab', virtualKeyCode: 9 });
  const cycled = await evaluate(`({ idx: wiring.armed.idx, name: wiring.nodes.find((n) => n.id === wiring.armed.candidates[wiring.armed.idx]).name })`);
  assert(cycled.idx === 2, `Tab did not cycle candidates: ${JSON.stringify(cycled)}`);
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  const wiredKb = await evaluate(`({ edges: wiring.edges.map((e) => e.from + '>' + e.to), selected: wiring.selected, announce: document.querySelector('#liveRegion').textContent })`);
  assert(wiredKb.edges.includes('wa3>wa2'), `Keyboard wiring did not create the handoff edge: ${JSON.stringify(wiredKb)}`);
  assert(/hands off/.test(wiredKb.announce), `Commit did not announce the typed relation: ${wiredKb.announce}`);

  /* invalid connections are refused non-destructively, with the reason */
  const inv1 = await evaluate(`tryConnect('wp1', 'wr1')`);
  const inv2 = await evaluate(`tryConnect('ws1', 'wa2')`);
  const inv3 = await evaluate(`tryConnect('wa1', 'wa1')`);
  const invState = await evaluate(`({ edges: wiring.edges.length, notice: document.querySelector('#wireNotice').textContent, visible: !document.querySelector('#wireNotice').hidden })`);
  assert(invState.edges === 7 && invState.visible && inv1 === null && inv2 === null && inv3 === null, `Invalid connections were not refused cleanly: ${JSON.stringify(invState)}`);
  assert(/prompt \/ goal wires to the agent/.test(invState.notice) || /never originate/.test(invState.notice) || /cannot connect to itself/.test(invState.notice), `Refusal explanation missing: ${invState.notice}`);

  /* graph origin and terminal are structural anchors, not removable cards */
  const anchorCount = await evaluate(`wiring.nodes.length`);
  await evaluate(`selectWire('wp1')`);
  await key('Delete', { code: 'Delete', virtualKeyCode: 46 });
  const keptOrigin = await evaluate(`({ n: wiring.nodes.length, notice: document.querySelector('#wireNotice').textContent })`);
  assert(keptOrigin.n === anchorCount && /graph origin/.test(keptOrigin.notice), `Prompt origin was removed or refusal was missing: ${JSON.stringify(keptOrigin)}`);

  /* edge selection, rewire, endpoint re-aim data path, remove */
  await evaluate(`selectWire('we2', 'edge')`);
  const edgeSel = await evaluate(`({ sel: wiring.selected, dots: document.querySelectorAll('#wireGroup .wire-end').length, rx: document.querySelectorAll('#edgeLabels .rx').length })`);
  assert(edgeSel.sel.type === 'edge' && edgeSel.dots === 1 && edgeSel.rx === 1, `Edge selection did not expose target reconnect + removal: ${JSON.stringify(edgeSel)}`);
  await key('r', { code: 'KeyR', virtualKeyCode: 82 });
  for (let i = 0; i < 10; i += 1) {
    const t = await evaluate(`wiring.armed ? wiring.armed.candidates[wiring.armed.idx] : null`);
    if (t === 'wa3') break;
    await key('Tab', { code: 'Tab', virtualKeyCode: 9 });
  }
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  const rewired = await evaluate(`({ edges: wiring.edges.map((e) => e.from + '>' + e.to), selected: wiring.selected })`);
  assert(rewired.edges.includes('wa1>wa3'), `R + Enter did not rewire the edge target: ${JSON.stringify(rewired)}`);
  await key('Delete', { code: 'Delete', virtualKeyCode: 46 });
  const afterDelete = await evaluate(`({ n: wiring.edges.length })`);
  assert(afterDelete.n === 6, `Delete did not remove the selected edge: ${JSON.stringify(afterDelete)}`);

  /* node drag by pointer moves the node freely and re-anchors its edges.
     Real CDP mouse input: synthetic PointerEvents do not honour pointer
     capture, and the product behaviour under test IS capture. */
  const dragFrom = await evaluate(`(() => {
    const el = document.querySelector('[data-wnode="wa2"], [data-node="wa2"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragFrom.x, y: dragFrom.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragFrom.x + 120, y: dragFrom.y + 70, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragFrom.x + 120, y: dragFrom.y + 70, button: 'left', clickCount: 1 });
  await sleep(120);
  const drag = await evaluate(`(() => {
    const n = wiring.nodes.find((x) => x.id === 'wa2');
    return { x: n.x, y: n.y, origX: 684, origY: 452, selected: wiring.selected };
  })()`);
  assert(drag.x > drag.origX && drag.y > drag.origY && drag.selected && drag.selected.id === 'wa2', `Pointer drag did not move the node freely: ${JSON.stringify(drag)}`);

  /* planned vs observed: replay is inert and labelled; live projects on a timer */
  const plannedBefore = await evaluate(`wiring.edges.map((e) => e.from + '>' + e.to).join(',')`);
  await evaluate(`wireReplay()`);
  const replay = await evaluate(`({
    badge: document.querySelector('#wireBadge').textContent,
    obs: wiring.observed.length,
    liveEdges: document.querySelectorAll('#provGroup .prov-live').length,
    planned: wiring.edges.length,
    plannedUnchanged: wiring.edges.map((e) => e.from + '>' + e.to).join(',')
  })`);
  assert(/Replay/.test(replay.badge) && replay.obs === 3 && replay.liveEdges === 0, `Replay is not inert/labelled: ${JSON.stringify(replay)}`);
  assert(replay.planned === 6 && replay.plannedUnchanged === plannedBefore, `Replay mutated the planned graph: ${JSON.stringify(replay)}`);
  await evaluate(`go('wiring'); null`);
  await sleep(5200);
  const live = await evaluate(`({ obs: wiring.observed.length, live: wiring.live, weft: document.querySelector('#cntWeft').textContent })`);
  assert(live.obs === 3 && live.weft === '×3', `Live provenance did not project automatically: ${JSON.stringify(live)}`);

  /* status system: running agent breathes blue while live, freezes on done */
  await navigate('wiring,dark');
  await sleep(2200);
  const statusSystem = await evaluate(`(() => {
    const a = document.querySelector('[data-node="wa1"]');
    const css = getComputedStyle(a);
    return { cls: a.className, animation: css.animationName, border: css.borderColor };
  })()`);
  assert(/st-running/.test(statusSystem.cls) && statusSystem.animation !== 'none', `Running agent lost the breathing border: ${JSON.stringify(statusSystem)}`);
  await evaluate(`document.documentElement.dataset.motion = 'reduce'; null`);
  const reducedWire = await evaluate(`(() => {
    const a = document.querySelector('[data-node="wa1"]');
    const css = getComputedStyle(a);
    return { animation: css.animationName, width: css.borderWidth };
  })()`);
  assert(reducedWire.animation === 'none' && reducedWire.width === '2px', `Reduced-motion wiring border not static: ${JSON.stringify(reducedWire)}`);
  await evaluate(`delete document.documentElement.dataset.motion; null`);

  /* both themes render the wiring screen; narrow retains discovery,
     tap/keyboard placement, relationship text, and the theme control. */
  for (const theme of ['dark', 'light']) {
    await navigate(`wiring,${theme}`);
    const themed = await evaluate(`({ theme: document.documentElement.dataset.theme,
      ground: getComputedStyle(document.querySelector('#stage')).backgroundColor,
      strip: !document.querySelector('#wireStrip').hidden,
      nodes: document.querySelectorAll('#nodes [data-wnode], #nodes [data-node]').length })`);
    assert(themed.nodes >= 8, `${theme} wiring lost nodes: ${JSON.stringify(themed)}`);
    await viewport(390, 844);
    await evaluate(`fit()`);   /* the product's own resize handler */
    const narrowWire = await evaluate(`(() => {
      const stage = document.querySelector('#stage');
      const library = document.querySelector('#library');
      const strip = document.querySelector('#wireStrip');
      const themeButton = document.querySelector('#themeBtn');
      const themeRect = themeButton.getBoundingClientRect();
      const themeHit = document.elementFromPoint(themeRect.left + themeRect.width / 2, themeRect.top + themeRect.height / 2);
      const kinds = wiring.nodes.map((n) => n.kind);
      return { layout: document.documentElement.dataset.layout,
        overflow: stage.scrollWidth - stage.clientWidth,
        library: getComputedStyle(library).display,
        libraryHeight: library.getBoundingClientRect().height,
        strip: getComputedStyle(strip).display,
        relations: [...document.querySelectorAll('#nodes .wire-narrow-rel')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.textContent.trim()),
        first: kinds[0], last: kinds[kinds.length - 1],
        themeTarget: themeRect.height, themeRight: themeRect.right,
        themeDisplay: getComputedStyle(themeButton).display,
        themeHit: themeHit?.closest('button')?.id || themeHit?.id || '',
        cards: document.querySelectorAll('#nodes > *').length };
    })()`);
    assert(narrowWire.layout === 'narrow' && narrowWire.overflow <= 1, `${theme} narrow wiring overflows: ${JSON.stringify(narrowWire)}`);
    assert(narrowWire.library === 'flex' && narrowWire.libraryHeight >= 240 && narrowWire.strip === 'flex', `${theme} narrow discovery/connection controls disappeared: ${JSON.stringify(narrowWire)}`);
    assert(narrowWire.relations.length >= 8 && narrowWire.relations.every(Boolean) && narrowWire.first === 'prompt' && narrowWire.last === 'response', `${theme} narrow relationship reading order is incomplete: ${JSON.stringify(narrowWire)}`);
    assert(narrowWire.themeTarget >= 44 && narrowWire.themeRight <= 390 && narrowWire.themeDisplay !== 'none' && narrowWire.themeHit === 'themeBtn', `${theme} narrow theme toggle is not reachable: ${JSON.stringify(narrowWire)}`);
    if (theme === 'dark') {
      const tapPlacement = await evaluate(`(() => {
        const before = wiring.nodes.length;
        document.querySelector('[data-res="r-skill-cite"]').click();
        const armed = !!wiring.placing;
        document.querySelector('[data-res="r-skill-cite"]').click();
        return { before, after: wiring.nodes.length, armed, placed: wiring.nodes[wiring.nodes.length - 1].ref };
      })()`);
      assert(tapPlacement.armed && tapPlacement.after === tapPlacement.before + 1 && tapPlacement.placed === 'r-skill-cite', `Narrow tap placement failed: ${JSON.stringify(tapPlacement)}`);
    }
    await viewport(1600, 1000);
  }

  assert(runtimeErrors.length === 0, `Standalone emitted runtime exceptions: ${JSON.stringify(runtimeErrors)}`);
  assert(requests.every((url) => url.startsWith('file:') || url.startsWith('data:')), `Standalone attempted a network request: ${JSON.stringify(requests)}`);

  assert(runtimeErrors.length === 0, `Standalone emitted runtime exceptions: ${JSON.stringify(runtimeErrors)}`);
  assert(requests.every((url) => url.startsWith('file:') || url.startsWith('data:')), `Standalone attempted a network request: ${JSON.stringify(requests)}`);

  console.log('TNG-119 + TNG-121 + TNG-122 + TNG-124 + TNG-125 verification passed: causal graph, editable pipeline, freeform placement + typed wiring (pointer, keyboard, narrow tap), resting grab affordance, armed-source row + cancel with focus return, capability library states, planned-vs-observed separation, interaction, overflow bounds, themes, narrow relationship flow, reduced motion, replay, retry retention, and offline loading');
} finally {
  if (socket) socket.close();
  await new Promise((resolveExit) => {
    if (chrome.exitCode !== null) return resolveExit();
    chrome.once('exit', resolveExit);
    chrome.kill('SIGTERM');
  });
  await rm(profile, { recursive: true, force: true });
}
