/* WebKit probe — the two things the board reported about the observed
 * provenance cluster on the Freeform wiring screen.
 *
 *   swift docs/mockups/verify-webkit.swift \
 *     docs/mockups/prototype-standalone.html \
 *     --eval docs/mockups/webkit-probe-provenance-drag.js
 *
 * The rejection, in their words: "i cannot move these 3 items and also, their
 * edge does not follow the node when I move the node." The screenshot is the
 * three observed evidence cards — #01 Notion, #02 Launch brief, #03
 * acme/loomwatch — with the EVIDENCE → RESPONSE and INVOKES labels around them,
 * which is the wiring screen's projection and nothing else in the prototype.
 *
 * So there are two independent claims and they are measured separately:
 *
 *   MOVE  — press an observed card, move, release. The card must end up where
 *           it was released, and must still be there after the next repaint
 *           (a card that snaps home on the following frame has not moved).
 *   TRACK — drag a planned node the observed edges are anchored to, and sample
 *           the edge geometry *during* the gesture, not only after it. An edge
 *           that only catches up on pointerup is exactly what "does not follow
 *           the node when I move the node" describes: for the whole time the
 *           node is under the pointer, the line is somewhere else.
 *
 * Sampling mid-drag is the point. Both of the prototype's node drags call
 * repaintEdges() on pointermove and the full paintWiring() only on release, so
 * a probe that measures before/after a completed gesture reports every edge as
 * correct and sees none of what the reviewer sees.
 *
 * The observed cluster is put on screen by setting the model rather than by
 * waiting out startObserve()'s 1.4s + 1.6s + 1.6s timers, because --eval gets
 * one synchronous shot at the page. The state it produces is the state the
 * board screenshotted: all three events projected, live.
 */
(function () {
  var out = [];
  var fails = 0;
  function check(ok, msg) { out.push('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + msg); if (!ok) fails++; }

  var stage = document.querySelector('#stage');

  function fire(el, type, x, y) {
    var init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0,
      buttons: (type === 'pointerup' || type === 'mouseup' || type === 'click') ? 0 : 1
    };
    var ev = /^pointer/.test(type)
      ? new PointerEvent(type, Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, init))
      : new MouseEvent(type, init);
    el.dispatchEvent(ev);
  }

  /* Every path in the observed layer, as one string. Any endpoint that moves
     changes it; nothing else on the screen can. */
  function provGeometry() {
    return [].slice.call(document.querySelectorAll('#provGroup path'))
      .map(function (p) { return p.getAttribute('d'); }).join(' | ');
  }
  function box(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  }
  function moved(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

  /* ---- put the screen in the state the board screenshotted ---------------- */
  go('wiring');
  wiring.observed = WIRE_OBSERVED.slice();
  paintWiring();

  var cards = [].slice.call(document.querySelectorAll('#overlay [data-wobs]'));
  out.push('screen: ' + stage.dataset.screen + ' | observed cards rendered: ' + cards.length
    + ' | observed edges: ' + document.querySelectorAll('#provGroup path').length);
  if (cards.length !== 3) {
    out.push('FAIL the three observed cards from the rejection screenshot are not on screen — '
      + 'the probe would be measuring something else');
    return out.join('\n') + '\nFAIL 1 check(s)';
  }

  /* ---- claim 1: "i cannot move these 3 items" ---------------------------- */
  out.push('');
  out.push('MOVE — press each observed card, carry it 150x90, release:');
  cards.forEach(function (card, i) {
    var el = document.querySelector('#overlay [data-wobs="' + card.dataset.wobs + '"]') || card;
    var r = el.getBoundingClientRect();
    var from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    var to = { x: from.x + 150, y: from.y + 90 };
    var before = box(el);

    fire(el, 'pointerdown', from.x, from.y);
    fire(el, 'mousedown', from.x, from.y);
    fire(el, 'pointermove', (from.x + to.x) / 2, (from.y + to.y) / 2);
    fire(el, 'mousemove', (from.x + to.x) / 2, (from.y + to.y) / 2);
    fire(el, 'pointermove', to.x, to.y);
    fire(el, 'mousemove', to.x, to.y);
    fire(el, 'pointerup', to.x, to.y);
    fire(el, 'mouseup', to.x, to.y);

    var live = document.querySelector('#overlay [data-wobs="' + card.dataset.wobs + '"]');
    var after = live ? box(live) : null;
    var carried = after ? moved(before, after) : 0;

    /* A card that moves under the pointer but snaps back on the next repaint
       has not been moved — the model never learned about it. */
    paintWiring();
    var again = document.querySelector('#overlay [data-wobs="' + card.dataset.wobs + '"]');
    var kept = again ? moved(before, box(again)) : 0;

    check(carried > 200 && kept > 200,
      'card ' + (i + 1) + ' (' + card.dataset.wobs + ') follows the pointer '
      + '(moved ' + carried + 'px during the gesture, ' + kept + 'px still after repaint; want >200 both)');
  });

  /* ---- claim 2: "their edge does not follow the node when I move the node" */
  out.push('');
  out.push('TRACK — drag a planned node the observed edges hang off, sampling mid-gesture:');
  [['wa1', 'the agent every observed edge originates at'],
   ['wr1', 'the response the evidence → response edge lands on']].forEach(function (pair) {
    var id = pair[0];
    var el = document.querySelector('#nodes [data-wnode="' + id + '"], #nodes [data-node="' + id + '"]');
    if (!el) { check(false, id + ' is not on the wiring screen — selector drift'); return; }
    var r = el.getBoundingClientRect();
    var from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    var to = { x: from.x - 120, y: from.y + 140 };

    var atRest = provGeometry();
    fire(el, 'pointerdown', from.x, from.y);
    fire(el, 'mousedown', from.x, from.y);
    fire(el, 'pointermove', to.x, to.y);
    fire(el, 'mousemove', to.x, to.y);
    var duringDrag = provGeometry();          /* pointer still down, node moved */
    fire(el, 'pointerup', to.x, to.y);
    fire(el, 'mouseup', to.x, to.y);
    var afterRelease = provGeometry();

    var nodeMoved = Math.round(moved(box(el), { x: r.left, y: r.top }));
    check(nodeMoved > 100, id + ' itself moved under the pointer (' + nodeMoved + 'px; want >100)');
    check(duringDrag !== atRest,
      'observed edges track ' + id + ' *while* it is being dragged — ' + pair[1]);
    check(afterRelease !== atRest,
      'observed edges are correct after release for ' + id);
  });

  /* ---- keyboard parity: the gesture must not be mouse-only --------------- */
  out.push('');
  out.push('KEYBOARD — select a card and press the arrow keys:');
  (function () {
    go('wiring');
    wiring.observed = WIRE_OBSERVED.slice();
    wiring.obsMoved = {};
    paintWiring();
    var card = document.querySelector('#overlay [data-wobs]');
    var id = card.dataset.wobs;
    card.click();
    var seat = WIRE_OBSERVED.filter(function (e) { return e.id === id; })[0];
    var before = box(document.querySelector('#overlay [data-wobs="' + id + '"]'));
    var geomBefore = provGeometry();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));

    /* Stage units and client pixels are not the same thing: #stage is a fixed
       1600x1000 coordinate space scaled to fit, so two 16px steps land short of
       32 client px. Assert the model in its own units, and separately that the
       rendered card actually followed. */
    var m = wiring.obsMoved[id];
    check(!!m && m.x === seat.x + 16 && m.y === seat.y + 16,
      'arrow keys move the selected card one 16px step each way ('
      + (m ? m.x + ',' + m.y : 'not moved') + ' from ' + seat.x + ',' + seat.y + ')');
    var live = document.querySelector('#overlay [data-wobs="' + id + '"]');
    check(live && moved(before, box(live)) > 0,
      'the rendered card followed the keyboard move (' + (live ? moved(before, box(live)) : 'gone') + ' client px)');
    check(provGeometry() !== geomBefore, 'the keyboard move takes the observed edges with it');
  })();

  /* ---- the deletion that used to freeze the screen ----------------------- */
  out.push('');
  out.push('SURVIVES DELETION — remove the node the observed edges hang off:');
  (function () {
    go('wiring');
    wiring.observed = WIRE_OBSERVED.slice();
    paintWiring();
    var threw = null;
    selectWire('wa1');
    try { deleteWireSelected(); } catch (err) { threw = String(err); }
    check(!threw, 'deleting the researcher repaints instead of throwing (' + (threw || 'no error') + ')');
    /* A repaint that threw halfway leaves the strip stale, so prove the whole
       pass ran, not just that no exception escaped. */
    var stillLive = false;
    try {
      wiring.observed = WIRE_OBSERVED.slice(0, 2);
      paintWiring();
      stillLive = /Observed ×2/.test(document.querySelector('#wireCounts').textContent);
    } catch (err) { stillLive = false; }
    check(stillLive, 'the screen keeps repainting afterwards — paintWiring completes to the wire strip');
  })();

  out.push('');
  out.push(fails
    ? 'FAIL ' + fails + ' check(s) — the observed provenance cluster does not behave like the rest of the canvas'
    : 'PASS observed cards move by pointer and keyboard, their edges follow during the gesture, '
      + 'and the layer survives losing its anchor');
  return out.join('\n');
})()
