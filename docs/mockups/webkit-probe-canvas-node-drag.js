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
     the gesture and reverted on release is not a move.

     The witness has to follow the screen. `wiring` and the graph screens keep their
     node positions in different models (`wiring.nodes` vs `POS`), and the first draft
     of this probe read `wiring.nodes` on every screen — including `canvas`, whose nodes
     it was written to interrogate. That is a witness for a model the screen under test
     does not use: it reported the true FAIL for the wrong reason, and would have gone
     on reporting FAIL against a canvas where every node moved correctly. A probe that
     cannot distinguish "not fixed" from "fixed" is worse than no probe. */
  function modelPos() {
    try {
      if (stage.dataset.screen === 'wiring') {
        return 'wiring:' + wiring.nodes.map(function (n) {
          return n.id + '@' + Math.round(n.x) + ',' + Math.round(n.y);
        }).sort().join('|');
      }
      return 'graph:' + Object.keys(POS).sort().map(function (k) {
        return k + '@' + Math.round(POS[k].x) + ',' + Math.round(POS[k].y);
      }).join('|');
    } catch (e) { return null; }
  }

  /* TRACK is only a question for a node something is drawn to. `codex` on the wiring
     screen is wired to nothing (incident = 0), so unchanged edge geometry after it
     moves is the correct answer, and scoring it a failure would be a probe that can
     never pass. Unknown model → assert anyway, so a witness we cannot read fails loud. */
  function incident(id) {
    try {
      if (stage.dataset.screen === 'wiring') {
        return wiring.edges.filter(function (e) { return e.from === id || e.to === id; }).length;
      }
      return GRAPHS[state.graph].edges.filter(function (e) { return e.from === id || e.to === id; }).length;
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

  /* Returns the edge geometry sampled *while the pointer is still down*, which is the
     half of the complaint a post-release check cannot see: "their edge does not follow
     the node when I move the node" was true of an implementation that repainted edges
     correctly, but only on release. Before and after look right; the whole gesture
     looks wrong. */
  function drag(el, dx, dy) {
    var r = el.getBoundingClientRect();
    var fx = r.left + r.width / 2, fy = r.top + r.height / 2;
    var midGeom = null;
    fire(el, 'pointerdown', fx, fy);
    fire(el, 'mousedown', fx, fy);
    for (var s = 1; s <= 5; s++) {
      var mx = fx + dx * s / 5, my = fy + dy * s / 5;
      var t = document.elementFromPoint(mx, my) || stage;
      fire(t, 'pointermove', mx, my);
      fire(t, 'mousemove', mx, my);
      fire(document, 'pointermove', mx, my);
      fire(document, 'mousemove', mx, my);
      if (s === 3) midGeom = edgeGeom();
    }
    var ex = fx + dx, ey = fy + dy;
    var endT = document.elementFromPoint(ex, ey) || stage;
    fire(endT, 'pointerup', ex, ey);
    fire(endT, 'mouseup', ex, ey);
    fire(document, 'pointerup', ex, ey);
    fire(document, 'mouseup', ex, ey);
    return midGeom;
  }

  /* Every screen that draws movable nodes, not only the one the prototype boots to.
     `canvas` is the surface the rejections come from and `wiring` is the surface the
     last fix landed on; checking one without the other is how a fix on either has
     twice been reported as a fix on both. Running both also makes the pair its own
     counterfactual: a harness that cannot drive a drag scores zero everywhere, so a
     result is only readable as a page defect when its sibling screen passes. */
  var SURFACES = ['canvas', 'wiring'];
  var totals = { moved: 0, nodes: 0 };

  out.push('screen at boot: ' + stage.dataset.screen);
  out.push('');

  /* REST — the derived curve is the curve that was reviewed.
     Making the edges movable meant replacing five hand-authored `d` strings with a
     function of the node positions. A refactor like that can silently redraw the graph
     the board has already looked at four times, so the authored strings are kept here
     as the expectation and compared against what is on screen at boot, before anything
     is dragged. Failure here means the fix changed the picture, which is its own defect.
     Same for the badges: they were authored at fixed coordinates that happen to be the
     midpoints of the curves they annotate, and must still land there. */
  var REST = {
    pipeline: {
      paths: [
        'M624 248 C 664 248 600 438 640 438',
        'M916 438 C 956 438 900 628 940 628',
        'M624 248 C 664 248 600 438 640 438',
        'M916 438 C 956 438 900 628 940 628',
        'M624 248 C 830 190 1070 380 940 628'
      ],
      labels: ['632,343', '928,533', '908,323']
    },
    team: {
      paths: [
        'M624 248 C 664 248 600 438 640 438',
        'M624 248 C 720 248 850 268 940 268',
        'M916 438 C 956 438 900 628 940 628',
        'M916 438 C 950 438 906 268 940 268'
      ],
      labels: []
    }
  };
  ['pipeline', 'team'].forEach(function (graph) {
    renderGraph(graph);
    var got = [].slice.call(document.querySelectorAll('#edgeGroup path')).map(function (p) {
      return p.getAttribute('d');
    });
    var gotLabels = [].slice.call(document.querySelectorAll('#edgeLabels .edge-label')).map(function (s) {
      return parseInt(s.style.left, 10) + ',' + parseInt(s.style.top, 10);
    });
    var pathsOk = got.join('|') === REST[graph].paths.join('|');
    var labelsOk = gotLabels.join('|') === REST[graph].labels.join('|');
    out.push('rest geometry, ' + graph + ': ' + (pathsOk ? 'paths match' : 'PATHS MOVED')
      + ', ' + (labelsOk ? 'badges match' : 'BADGES MOVED'));
    if (!pathsOk) { fails++; out.push('    want ' + REST[graph].paths.join(' · '));
                    out.push('    got  ' + got.join(' · ')); }
    if (!labelsOk) { fails++; out.push('    want ' + REST[graph].labels.join(' · '));
                     out.push('    got  ' + gotLabels.join(' · ')); }
  });
  out.push('');

  SURFACES.forEach(function (screen) {
    go(screen);
    out.push(screen + (screen === 'canvas' ? '  (the screen the prototype opens to)' : ''));

    if (stage.dataset.screen !== screen) {
      out.push('  SKIP screen did not activate'); fails++; return;
    }
    if (modelPos() === null) { out.push('  SKIP no reachable node model here'); fails++; return; }

    /* Hold node *identities*, never the elements. Both surfaces re-render #nodes when a
       drag drops — deliberately, so the click the UA synthesizes afterwards lands on a
       detached node instead of opening the inspector. A list of elements captured up
       front therefore goes stale after the first successful drag, and every node after
       the first is dispatched at an orphan and scores immovable. That reads exactly
       like a real defect: "1/3 move". Re-query by id before each gesture. */
    var ids = [].slice.call(stage.querySelectorAll('#nodes .node'))
      .filter(reachable)
      .map(function (el) { return el.dataset.wnode || el.dataset.node; })
      .filter(Boolean);
    if (!ids.length) { out.push('  SKIP no reachable nodes here'); fails++; return; }

    var immovable = [];
    var stale = [];

    ids.forEach(function (id) {
      var el = stage.querySelector('#nodes [data-wnode="' + id + '"], #nodes [data-node="' + id + '"]');
      if (!el || !reachable(el)) {
        immovable.push(id);
        out.push('  ' + id + ' — vanished from the screen before it could be dragged');
        return;
      }
      var name = (el.getAttribute('aria-label') || el.textContent || '').split(',')[0].trim().slice(0, 40);
      var posBefore = modelPos();
      var geomBefore = edgeGeom();

      var midGeom = drag(el, 120, 80);

      var moved = modelPos() !== posBefore;
      var edgeMoved = edgeGeom() !== geomBefore;
      var edgeMovedDuring = midGeom !== null && midGeom !== geomBefore;
      var wired = incident(id);

      if (!moved) {
        immovable.push(name);
        out.push('  ' + name + ' — MOVE no: a press-drag-release left its model position unchanged');
      } else if (wired === 0) {
        out.push('  ' + name + ' — ok moves (nothing is wired to it, so no edge to track)');
      } else if (geomBefore !== null && !edgeMoved) {
        stale.push(name);
        out.push('  ' + name + ' — MOVE ok, TRACK no: it moved but the edge geometry did not change');
      } else if (!edgeMovedDuring) {
        stale.push(name);
        out.push('  ' + name + ' — MOVE ok, TRACK late: the edges only caught up on release');
      } else {
        out.push('  ' + name + ' — ok moves, and its ' + wired + ' edge(s) follow while dragging');
      }
    });

    totals.nodes += ids.length;
    totals.moved += ids.length - immovable.length;
    out.push('  moved by a real drag: ' + (ids.length - immovable.length) + '/' + ids.length);
    out.push('');
    fails += immovable.length + stale.length;
  });

  if (totals.moved === 0 && totals.nodes > 0) {
    out.push('NOTE every node on every surface reports immovable — no surface disagrees, so');
    out.push('     check the harness before reading this as a page defect.');
    out.push('');
  }

  out.push('total moved by a real drag: ' + totals.moved + '/' + totals.nodes);
  out.push(fails
    ? 'FAIL ' + fails + ' node(s) cannot be moved or moved with stale edges'
    : 'PASS every node on every graph surface moves, and its edges follow');
  return out.join('\n');
})()
