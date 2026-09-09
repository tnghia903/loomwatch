#!/usr/bin/env node
/* Focused TNG-115 verifier for the generated standalone candidate.
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
const profile = await mkdtemp(resolve(scratch, 'loomwatch-tng115-'));

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
    if (!message.id || !pending.has(message.id)) return;
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
  await send('Page.navigate', { url: `${pathToFileURL(artifact).href}#${hash}` });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate("document.readyState === 'complete' && !!document.querySelector('#stage[data-screen]')")) break;
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
  await evaluate("document.querySelector('[data-node=\"n1\"]').focus()");
  await key('Enter', { code: 'Enter', virtualKeyCode: 13 });
  const nodeOpened = await evaluate("({hidden:document.querySelector('#inspector').hidden, active:document.activeElement.outerHTML.slice(0,160), selected:document.querySelector('[data-node=\"n1\"]')?.getAttribute('aria-expanded')})");
  assert(!nodeOpened.hidden && nodeOpened.selected === 'true' && /data-node=/.test(nodeOpened.active), `Enter did not open the node inspector with stable focus: ${JSON.stringify(nodeOpened)}`);
  await key('Escape', { code: 'Escape', virtualKeyCode: 27 });
  const nodeClosed = await evaluate("({hidden:document.querySelector('#inspector').hidden, active:document.activeElement.outerHTML.slice(0,160), node:document.querySelector('[data-node=\"n1\"]')?.outerHTML.slice(0,100)})");
  assert(nodeClosed.hidden && /data-node=/.test(nodeClosed.active), `Node inspector dismissal did not restore focus: ${JSON.stringify(nodeClosed)}`);

  await navigate('running,dark');
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

  await viewport(390, 844);
  for (const theme of ['dark', 'light']) {
    await navigate(`answered,${theme}`);
    const narrow = await evaluate(`(() => {
      const stage = document.querySelector('#stage');
      const response = document.querySelector('#runtimeResponse');
      const composer = document.querySelector('#composer');
      const themeButton = document.querySelector('#themeBtn');
      const themeRect = themeButton.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      return {
        layout: document.documentElement.dataset.layout,
        theme: document.documentElement.dataset.theme,
        transform: getComputedStyle(stage).transform,
        responseFont: getComputedStyle(response.querySelector('.rr-body')).fontSize,
        themeTarget: themeButton.getBoundingClientRect().height,
        themeDisplay: getComputedStyle(themeButton).display,
        themeRight: themeRect.right,
        composerWidth: composerRect.width,
        composerBottom: composerRect.bottom,
        stageWidth: stage.clientWidth,
        viewportHeight: innerHeight,
        overflow: stage.scrollWidth - stage.clientWidth
      };
    })()`);
    assert(narrow.layout === 'narrow' && narrow.theme === theme, `${theme} narrow mode did not initialize`);
    assert(narrow.transform === 'none', `${theme} narrow mode still scales the stage`);
    assert(narrow.responseFont === '14px', `${theme} narrow response text was scaled`);
    assert(narrow.themeTarget >= 44 && narrow.themeDisplay !== 'none' && narrow.themeRight <= 390, `${theme} narrow theme control is not visible/reachable: ${JSON.stringify(narrow)}`);
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

  console.log('TNG-115 verification: 26 assertions passed');
} finally {
  if (socket) socket.close();
  await new Promise((resolveExit) => {
    if (chrome.exitCode !== null) return resolveExit();
    chrome.once('exit', resolveExit);
    chrome.kill('SIGTERM');
  });
  await rm(profile, { recursive: true, force: true });
}
