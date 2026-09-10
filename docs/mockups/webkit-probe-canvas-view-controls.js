/* WebKit probe — do the view controls and the mode pill keep their promises?
 *
 *   swift docs/mockups/verify-webkit.swift \
 *     docs/mockups/prototype-standalone.html \
 *     --eval docs/mockups/webkit-probe-canvas-view-controls.js
 *
 * The affordance sweep asks "I pressed it, did anything happen?", which is the right
 * question for clearing a control that answers nothing. It is the wrong question for a
 * control that has just been implemented: "something changed" is satisfied by a zoom
 * button that scales the whole window, by a Fit that leaves half the graph off-screen,
 * and by a popover that opens empty. Those all pass a liveness check and fail a review.
 *
 * So this asserts the specific claims made for TNG-131:
 *
 *   ZOOM     — CANVAS_SPEC §7.1: range 0.25–2.0, default 1.0. The graph scales and the
 *              chrome does not, because an app window whose panels grow when you zoom
 *              the canvas is scaling a screenshot, not zooming.
 *   CLAMP    — the ends of the range are reachable and stop, and the button that can no
 *              longer do anything says so by disabling.
 *   POINTER  — a drag at a zoom other than 1.0 still lands under the pointer. This is
 *              the failure the zoom implementation most easily introduces and the one a
 *              screenshot cannot show.
 *   FIT      — §7.1: 64 px padding, capped at 1.0. Asserted against nodes deliberately
 *              scattered first, so a Fit that does nothing cannot pass.
 *   MODE POP — §8.1: opens, explains the mode it is actually in, names the anomaly the
 *              pill counts, and carries the guards/budget fields that have no other home.
 */
(function () {
  var out = [];
  var fails = 0;
  var stage = document.querySelector('#stage');

  function ok(cond, label, detail) {
    out.push((cond ? '  ok   ' : '  FAIL ') + label + (detail == null ? '' : ' — ' + detail));
    if (!cond) fails++;
  }

  function fire(el, type, x, y) {
    var init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0,
      buttons: (type === 'pointerup' || type === 'mouseup' || type === 'click') ? 0 : 1
    };
    el.dispatchEvent(/^pointer/.test(type)
      ? new PointerEvent(type, Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, init))
      : new MouseEvent(type, init));
  }
  function press(el) {
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    fire(el, 'pointerdown', x, y); fire(el, 'mousedown', x, y);
    fire(el, 'pointerup', x, y); fire(el, 'mouseup', x, y); fire(el, 'click', x, y);
  }
  function rect(sel) {
    var el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    var r = el.getBoundingClientRect();
    return Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
  }
  function nodeRect(id) {
    var el = document.querySelector('#nodes [data-node="' + id + '"]');
    return el ? el.getBoundingClientRect() : null;
  }

  go('canvas');
  out.push('screen: ' + stage.dataset.screen + ' | zoom at boot: ' + state.view.z);
  out.push('');

  /* ---- ZOOM: the graph scales, the chrome does not ---------------------------- */
  out.push('ZOOM — the graph scales and the chrome stays put (§7.1)');
  var CHROME = ['#library', '#chip', '#modepill', '#viewctl'];
  var chromeBefore = CHROME.map(rect).join(' | ');
  var nodeBefore = nodeRect('n1');

  press(document.querySelector('#zoomIn'));
  var nodeAfter = nodeRect('n1');
  ok(state.view.z > 1, 'zoom in raised the zoom level', '1 → ' + state.view.z);
  ok(nodeAfter && nodeBefore && nodeAfter.width > nodeBefore.width + 1,
    'the node grew on screen', Math.round(nodeBefore.width) + 'px → ' + Math.round(nodeAfter.width) + 'px');
  ok(CHROME.map(rect).join(' | ') === chromeBefore,
    'every chrome panel is exactly where it was', 'library, chip, mode pill, view controls');
  ok((document.querySelector('#zoomLevel') || {}).textContent === Math.round(state.view.z * 100) + '%',
    'the readout reports the level', (document.querySelector('#zoomLevel') || {}).textContent);

  press(document.querySelector('#zoomOut'));
  ok(Math.abs(state.view.z - 1) < 1e-6, 'one step back returns to 100%', state.view.z);
  out.push('');

  /* ---- CLAMP ------------------------------------------------------------------ */
  out.push('CLAMP — the documented range is reachable and stops there');
  for (var i = 0; i < 20; i++) press(document.querySelector('#zoomOut'));
  ok(Math.abs(state.view.z - 0.25) < 1e-6, 'zoom out stops at the §7.1 floor', state.view.z);
  ok(document.querySelector('#zoomOut').disabled, 'and the button that can do no more is disabled');
  for (i = 0; i < 30; i++) press(document.querySelector('#zoomIn'));
  ok(Math.abs(state.view.z - 2) < 1e-6, 'zoom in stops at the §7.1 ceiling', state.view.z);
  ok(document.querySelector('#zoomIn').disabled, 'and that button disables too');
  ok(!document.querySelector('#zoomOut').disabled, 'zoom out is live again at the ceiling');
  out.push('');

  /* ---- POINTER: a drag still lands under the pointer at a non-1 zoom ----------- */
  out.push('POINTER — dragging at a zoom other than 1.0');
  go('canvas');
  press(document.querySelector('#zoomOut'));
  press(document.querySelector('#zoomOut'));
  var z = state.view.z;
  ok(z < 1, 'zoomed out for the test', z);

  var el = document.querySelector('#nodes [data-node="n1"]');
  var before = { x: POS.n1.x, y: POS.n1.y };
  var r0 = el.getBoundingClientRect();
  var fx = r0.left + r0.width / 2, fy = r0.top + r0.height / 2;
  var DX = 160, DY = 100;
  fire(el, 'pointerdown', fx, fy); fire(el, 'mousedown', fx, fy);
  for (i = 1; i <= 5; i++) {
    var mx = fx + DX * i / 5, my = fy + DY * i / 5;
    fire(el, 'pointermove', mx, my);
    fire(document, 'pointermove', mx, my);
  }
  fire(el, 'pointerup', fx + DX, fy + DY);
  fire(document, 'pointerup', fx + DX, fy + DY);

  /* client px → content px is the stage's own fit scale times the canvas zoom */
  var sr = stage.getBoundingClientRect();
  var fitScale = sr.width / 1600;
  var wantX = before.x + Math.round(DX / (fitScale * z));
  var wantY = before.y + Math.round(DY / (fitScale * z));
  var slack = 3;
  ok(Math.abs(POS.n1.x - wantX) <= slack && Math.abs(POS.n1.y - wantY) <= slack,
    'the node followed the pointer, not a multiple of it',
    'want ~' + wantX + ',' + wantY + ' · got ' + POS.n1.x + ',' + POS.n1.y);
  out.push('');

  /* ---- FIT -------------------------------------------------------------------- */
  out.push('FIT — scatter the graph, then ask it to frame the result (§7.1)');
  go('canvas');
  POS.n1 = { x: 20, y: 900 }; POS.n2 = { x: 1300, y: 20 }; POS.n3 = { x: 1320, y: 890 };
  renderGraph('pipeline');
  var vp = workRect();
  var offBefore = ['n1', 'n2', 'n3'].filter(function (id) {
    var r = nodeRect(id);
    return r.left < sr.left + vp.x * fitScale - 1 || r.right > sr.left + (vp.x + vp.w) * fitScale + 1
        || r.top < sr.top + vp.y * fitScale - 1 || r.bottom > sr.top + (vp.y + vp.h) * fitScale + 1;
  });
  ok(offBefore.length > 0, 'the scattered graph does not fit before Fit is pressed',
    offBefore.length + ' node(s) outside the working area');

  press(document.querySelector('#fitBtn'));
  var offAfter = ['n1', 'n2', 'n3'].filter(function (id) {
    var r = nodeRect(id);
    return r.left < sr.left + vp.x * fitScale - 2 || r.right > sr.left + (vp.x + vp.w) * fitScale + 2
        || r.top < sr.top + vp.y * fitScale - 2 || r.bottom > sr.top + (vp.y + vp.h) * fitScale + 2;
  });
  ok(offAfter.length === 0, 'after Fit every node is inside the area the chrome leaves free',
    offAfter.length ? 'still outside: ' + offAfter.join(', ') : '3/3 framed');
  ok(state.view.z <= 1 + 1e-6, 'Fit never magnifies past 100%', state.view.z);
  ok(state.view.z >= 0.25, 'and stays inside the range', state.view.z);
  out.push('');

  /* ---- MODE POPOVER ----------------------------------------------------------- */
  out.push('MODE PILL — §8.1, the only place execution semantics are explained');
  go('canvas');
  var pill = document.querySelector('#modepill');
  ok(pill.tagName === 'BUTTON', 'the pill is a real control', '<' + pill.tagName.toLowerCase() + '>');
  ok(document.querySelector('#modePop').hidden, 'the popover is disclosed, not resident');

  press(pill);
  var pop = document.querySelector('#modePop');
  var text = (pop.textContent || '').replace(/\s+/g, ' ');
  ok(!pop.hidden, 'pressing the pill opens it');
  ok(pill.getAttribute('aria-expanded') === 'true', 'and says so to assistive tech');
  ok(/Three steps run in the order you drew/.test(text), 'it explains the mode it is actually in');
  ok(/dispatch/.test(text) && /handoff/.test(text), 'and which tools are withdrawn in that mode');
  ok(pop.querySelectorAll('.mp-order li').length === 3, 'the resolved order is listed',
    pop.querySelectorAll('.mp-order li').length + ' steps');
  ok(/skipped reviewer/i.test(text), 'the anomaly the pill counts is finally named');
  ok(pop.querySelectorAll('.mp-guards input').length === 3, 'guards and budget are editable here',
    pop.querySelectorAll('.mp-guards input').length + ' fields');

  /* the fields are the edit affordance, so they have to actually take an edit */
  var depth = pop.querySelector('.mp-guards input');
  depth.value = '4';
  depth.dispatchEvent(new Event('input', { bubbles: true }));
  ok(teamExec.depth === 4, 'editing a guard updates the model', 'maxDispatchDepth = ' + teamExec.depth);

  press(pill);
  ok(document.querySelector('#modePop').hidden, 'pressing the pill again closes it');
  ok(pill.getAttribute('aria-expanded') === 'false', 'and clears the expanded state');

  press(pill);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(document.querySelector('#modePop').hidden, 'Escape closes it too');

  /* team mode is the other half of §8.1 and says something different */
  go('team');
  press(document.querySelector('#modepill'));
  var teamText = (document.querySelector('#modePop').textContent || '').replace(/\s+/g, ' ');
  ok(/edges is empty/.test(teamText), 'in team mode it explains the empty-edges rule');
  ok(/All six Team Bus tools/.test(teamText), 'and that all six bus tools are available');
  ok(!/steps run in the order/.test(teamText), 'and does not repeat the pipeline sentence');
  out.push('');

  /* ---- the shortcuts §7.1 names ----------------------------------------------- */
  out.push('SHORTCUTS — the keys the buttons advertise');
  go('canvas');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', metaKey: true, bubbles: true, cancelable: true }));
  ok(state.view.z > 1, '⌘+ zooms in', state.view.z);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', metaKey: true, bubbles: true, cancelable: true }));
  ok(Math.abs(state.view.z - 1) < 1e-6, '⌘− zooms back out', state.view.z);
  POS.n1 = { x: 20, y: 900 };
  renderGraph('pipeline');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }));
  ok(state.view.z < 1, 'F fits the scattered graph', state.view.z);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', metaKey: true, bubbles: true, cancelable: true }));
  ok(Math.abs(state.view.z - 1) < 1e-6, '⌘0 resets to 100%', state.view.z);

  /* the documentation boards have no canvas, so the browser keeps its own zoom */
  go('system');
  var zBefore = state.view.z;
  var ev = new KeyboardEvent('keydown', { key: '=', metaKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(ev);
  ok(!ev.defaultPrevented && state.view.z === zBefore,
    '⌘+ is left to the browser on a screen with no canvas');
  out.push('');

  out.push(fails ? 'FAIL ' + fails + ' assertion(s)' : 'PASS view controls and the mode pill keep their promises');
  return out.join('\n');
})()
