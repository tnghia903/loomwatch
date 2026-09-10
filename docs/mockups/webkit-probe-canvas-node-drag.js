/* WebKit probe — can the nodes on the default `canvas` screen actually be moved?
 *
 *   swift docs/mockups/verify-webkit.swift \
 *     docs/mockups/prototype-standalone.html \
 *     --eval docs/mockups/webkit-probe-canvas-node-drag.js
 *
 * Why this exists, when webkit-probe-canvas-affordances.js already sweeps this screen
 * ---------------------------------------------------------------------------------
 * The affordance sweep asks one question per control: "I pressed it — did anything
 * happen?" That question is deliberately broad, because its job is to clear controls
 * that promise interaction and deliver none.
 *
 * A canvas node is a `<button>`. Pressing it selects it, which mutates the DOM. So the
 * sweep scores all three canvas nodes as live and never examines them again — its drag
 * ("carry") gesture is only consulted for controls that failed the press, in
 * `if (!activated && !carried)`. A node that selects on click but cannot be dragged
 * passes the sweep with full marks.
 *
 * That is a real gap, not a hypothetical: at the bytes the sweep last reported
 * "27/34 answered a press", 3 of 3 canvas nodes could not be moved by a drag.
 * "Did anything happen?" cannot catch a control that answers the wrong gesture, and it
 * cannot catch a *correctness* failure where something did happen but was wrong — an
 * edge that fails to follow the node it is anchored to.
 *
 * So this probe asserts the specific promised behaviour instead of mere responsiveness:
 *
 *   MOVE  — press a node, move in steps, release. CANVAS_SPEC §7.2 makes this
 *           first-class (`snapGrid = [8,8]`, "snapping on while dragging", alignment
 *           guides "when a dragged node's centre or edge is within 4px", collision
 *           offset on drop). Pipeline mode adds only a step *badge* from
 *           `pipeline_order()` (§9); it does not derive layout, and auto-layout is an
 *           explicit command (⌥⌘L), not a standing constraint. So an immovable node on
 *           this screen is a spec gap, not a mode rule.
 *
 *   TRACK  — after a node does move, its incident edges must have moved with it.
 *           Measured only when MOVE succeeded, because an edge that "did not change"
 *           beside a node that never moved proves nothing.
 *
 * Gestures are driven as a real pointer sequence and the moves are also dispatched at
 * `document`, because drag implementations commonly bind their move/up listeners
 * there after pointerdown rather than to the node itself. Dispatching only on the
 * element reports a working drag as broken.
 */
(function () {
  var out = [];
  var fails = 0;
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

  function hash(s) {
    var h = 5381, i = 0;
    for (; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  function reachable(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
    if (r.right <= 0 || r.left >= window.innerWidth) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none';
  }

  /* The model is the honest witness for "did it move": a CSS transform applied during
     the gesture and reverted on release is not a move. */
  function modelPos() {
    try {
      return wiring.nodes.map(function (n) {
        return n.id + '@' + Math.round(n.x) + ',' + Math.round(n.y);
      }).sort().join('|');
    } catch (e) { return null; }
  }

  function edgeGeom() {
    var svg = document.querySelector('#edges');
    if (!svg) return null;
    return hash([].slice.call(svg.querySelectorAll('path,line,polyline')).map(function (p) {
      return p.getAttribute('d')
        || [p.getAttribute('x1'), p.getAttribute('y1'), p.getAttribute('x2'), p.getAttribute('y2')].join(',');
    }).join('|'));
  }

  function drag(el, dx, dy) {
    var r = el.getBoundingClientRect();
    var fx = r.left + r.width / 2, fy = r.top + r.height / 2;
    fire(el, 'pointerdown', fx, fy);
    fire(el, 'mousedown', fx, fy);
    for (var s = 1; s <= 5; s++) {
      var mx = fx + dx * s / 5, my = fy + dy * s / 5;
      var t = document.elementFromPoint(mx, my) || stage;
      fire(t, 'pointermove', mx, my);
      fire(t, 'mousemove', mx, my);
      fire(document, 'pointermove', mx, my);
      fire(document, 'mousemove', mx, my);
    }
    var ex = fx + dx, ey = fy + dy;
    var endT = document.elementFromPoint(ex, ey) || stage;
    fire(endT, 'pointerup', ex, ey);
    fire(endT, 'mouseup', ex, ey);
    fire(document, 'pointerup', ex, ey);
    fire(document, 'mouseup', ex, ey);
  }

  out.push('screen at boot: ' + stage.dataset.screen);
  if (modelPos() === null) {
    out.push('SKIP no reachable node model on this screen');
    return out.join('\n');
  }

  var nodes = [].slice.call(stage.querySelectorAll('.node')).filter(reachable);
  out.push('reachable nodes on the reviewed screen: ' + nodes.length);
  out.push('');

  var immovable = [];
  var stale = [];

  nodes.forEach(function (el) {
    var name = (el.getAttribute('aria-label') || el.textContent || '').split(',')[0].trim().slice(0, 40);
    var posBefore = modelPos();
    var geomBefore = edgeGeom();

    drag(el, 120, 80);

    var moved = modelPos() !== posBefore;
    var edgeMoved = edgeGeom() !== geomBefore;

    if (!moved) {
      immovable.push(name);
      out.push('  ' + name + ' — MOVE no: a press-drag-release left its model position unchanged');
    } else if (geomBefore !== null && !edgeMoved) {
      stale.push(name);
      out.push('  ' + name + ' — MOVE ok, TRACK no: it moved but the edge geometry did not change');
    } else {
      out.push('  ' + name + ' — ok moves, and its edges move with it');
    }
  });

  /* Counterfactual: if the harness could not drive a drag at all it would report every
     node immovable. A mixed result is evidence about the page; a total is a prompt to
     check the harness before believing it. */
  out.push('');
  out.push('moved by a real drag: ' + (nodes.length - immovable.length) + '/' + nodes.length);
  if (immovable.length === nodes.length && nodes.length > 0) {
    out.push('NOTE all nodes report immovable — confirm against a surface where dragging is');
    out.push('     known to work before reading this as a page defect.');
  }

  fails += immovable.length + stale.length;
  out.push('');
  out.push(fails
    ? 'FAIL ' + immovable.length + ' node(s) cannot be moved, ' + stale.length + ' moved with stale edges'
    : 'PASS every node on the reviewed screen moves, and its edges follow');
  return out.join('\n');
})()
