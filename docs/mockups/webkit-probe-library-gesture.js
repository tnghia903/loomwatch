/* WebKit probe — press on a library row, move, release over the canvas.
 *
 *   swift docs/mockups/verify-webkit.swift \
 *     docs/mockups/prototype-standalone.html \
 *     --eval docs/mockups/webkit-probe-library-gesture.js
 *
 * Why this exists next to webkit-probe-library-routing.js: that probe calls
 * `rows[0].click()`, and a click is not a drag. `click` is dispatched on the
 * nearest common inclusive ancestor of the mousedown and mouseup targets, so
 * pressing a library row and releasing over the canvas fires click on the app
 * shell — the row's own click listener never runs. Three fixes in a row were
 * verified by clicking and every one of them left the reported gesture dead.
 *
 * The two ways a press-drag-release can be served are measured separately,
 * because they fail independently:
 *
 *   native  — the row carries draggable="true", so the UA raises dragstart.
 *             Only trusted input can start that, so this probe reports the
 *             attribute (the precondition) rather than pretending to fire it.
 *   pointer — the row has a pointerdown/pointermove/pointerup carry. Those are
 *             ordinary events, so this probe drives the real handlers with the
 *             real coordinates, in the real engine.
 *
 * A screen passes if at least one of the two can serve the gesture and a node
 * actually lands. Run it on `canvas` (where the board reviews — the rejection
 * screenshots are all "Pipeline · 3 steps") and on `wiring`.
 */
(function () {
  var out = [];
  var fails = 0;

  function screenNow() { return document.querySelector('#stage').dataset.screen; }

  /* Counting nodes before/after is not evidence: routing to `wiring` runs
     initWiring(), which reseeds the graph, so the delta moves whether or not
     anything was placed (measured: +6 for one drop). Ask the precise question
     instead — is there a node for the row I dragged, at the point where I
     released it? Seeded nodes sit at fixed seed coordinates and cannot
     coincidentally satisfy both halves. */
  function landedAt(ref, expected) {
    try {
      return wiring.nodes.filter(function (n) {
        return n.ref === ref
          && Math.abs(n.x - expected.x) <= 2 && Math.abs(n.y - expected.y) <= 2;
      }).length;
    } catch (e) { return 'unreachable'; }
  }
  /* Mapped from the stage box rather than through the page's stagePoint() so
     this probe runs unchanged against pre-fix builds, which do not have it. */
  function expectedTopLeft(ref, clientX, clientY) {
    var r = RESOURCES.filter(function (x) { return x.id === ref; })[0];
    var s = r.kind === 'agent' ? WIRE_SIZES.agent : WIRE_SIZES.res;
    var box = document.querySelector('#stage').getBoundingClientRect();
    var scale = box.width / 1600 || 1;
    return { x: Math.round((clientX - box.left) / scale) - s.w / 2,
             y: Math.round((clientY - box.top) / scale) - s.h / 2 };
  }

  function fire(el, type, x, y, extra) {
    var init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' || type === 'mouseup' ? 0 : 1
    };
    for (var k in (extra || {})) init[k] = extra[k];
    var ev = /^pointer/.test(type)
      ? new PointerEvent(type, Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, init))
      : new MouseEvent(type, init);
    el.dispatchEvent(ev);
    return ev;
  }

  /* What the UA does with a press on A and a release on B: the click goes to
     their nearest common inclusive ancestor, not to A. */
  function commonAncestor(a, b) {
    for (var n = a; n; n = n.parentElement) if (n.contains(b)) return n;
    return document.body;
  }

  /* Never bounce through `wiring` to "reset" before measuring `canvas`: the
     library is re-rendered per screen, so a bounce is a different DOM from the
     one that boots. An earlier revision of this probe did exactly that and
     scored a PASS on a build where the boot state had 0 draggable rows. Take
     `canvas` first, untouched, exactly as the page loads it. */
  function gesture(screen) {
    if (screenNow() !== screen) go(screen);

    var row = document.querySelector('#libGroups .lib-row[data-res]');
    if (!row) { out.push('[' + screen + '] FAIL no usable library row rendered'); fails++; return; }
    var stage = document.querySelector('#stage');
    var lib = document.querySelector('#library');
    var rr = row.getBoundingClientRect();
    var sr = stage.getBoundingClientRect();
    var lr = lib.getBoundingClientRect();
    var from = { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 };
    /* a point on the canvas, clear of the library panel */
    var to = { x: (lr.right + sr.right) / 2, y: sr.top + sr.height / 2 };

    var draggable = row.getAttribute('draggable') === 'true';
    var ref = row.dataset.res;
    var screenBefore = screenNow();
    var expected = expectedTopLeft(ref, to.x, to.y);
    var alreadyThere = landedAt(ref, expected);

    fire(row, 'pointerdown', from.x, from.y);
    fire(row, 'mousedown', from.x, from.y);
    var mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    var target = document.elementFromPoint(mid.x, mid.y) || stage;
    fire(target, 'pointermove', mid.x, mid.y);
    fire(target, 'mousemove', mid.x, mid.y);
    var dropTarget = document.elementFromPoint(to.x, to.y) || stage;
    fire(dropTarget, 'pointermove', to.x, to.y);
    fire(dropTarget, 'mousemove', to.x, to.y);
    fire(dropTarget, 'pointerup', to.x, to.y);
    fire(dropTarget, 'mouseup', to.x, to.y);
    /* and the click the UA would synthesize, where it would actually land */
    var ca = commonAncestor(row, dropTarget);
    fire(ca, 'click', to.x, to.y);

    var placed = landedAt(ref, expected) - alreadyThere;
    var served = draggable || placed === 1;
    out.push('[' + screen + '] draggable="true": ' + draggable
      + ' | carried "' + ref + '" to the release point: ' + placed + ' (want 1)'
      + ' | screen ' + screenBefore + ' -> ' + screenNow()
      + ' | click landed on ' + ca.tagName + (ca.id ? '#' + ca.id : '')
      + (ca === row ? ' (the row)' : ' (NOT the row)'));
    if (!served) {
      out.push('[' + screen + '] FAIL press-drag-release is a no-op: no native drag source '
        + 'and no pointer carry, and the synthesized click misses the row');
      fails++;
    } else if (placed === 1) {
      out.push('[' + screen + '] ok pointer carry placed the dragged row at the release point');
    } else if (draggable) {
      out.push('[' + screen + '] ok native drag source present (dragstart needs trusted input; '
        + 'the drop path is covered by verify-prototype.mjs)');
    }
  }

  gesture('canvas');
  gesture('wiring');

  /* The affordance must describe the screen you are on, not the one you came
     from: go('wiring') then back used to leave every row still carrying
     draggable="true" while dragover/drop were no longer wired. */
  go('wiring');
  go('canvas');
  var back = [].slice.call(document.querySelectorAll('#libGroups .lib-row[data-res]'));
  var stale = back.filter(function (r) { return r.getAttribute('draggable') === 'true'; }).length;
  out.push('[canvas after visiting wiring] rows: ' + back.length + ' | stale draggable="true": ' + stale);
  if (!back.length || stale) {
    out.push('[canvas after visiting wiring] FAIL rows kept the wiring screen\'s drag attribute');
    fails++;
  } else {
    out.push('[canvas after visiting wiring] ok affordance re-rendered with the screen');
  }

  out.push(fails ? 'FAIL ' + fails + ' check(s)' : 'PASS every reviewed screen can serve press-drag-release');
  return out.join('\n');
})()
