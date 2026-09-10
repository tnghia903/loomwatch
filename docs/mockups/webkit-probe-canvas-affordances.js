/* WebKit probe — sweep every affordance the board can reach on the screen they
 * actually review, and find the ones that promise interaction and deliver none.
 *
 *   swift docs/mockups/verify-webkit.swift \
 *     docs/mockups/prototype-standalone.html \
 *     --eval docs/mockups/webkit-probe-canvas-affordances.js
 *
 * Why this exists
 * ---------------
 * Four rounds of "I cannot drag the agent from the library" were each closed by
 * fixing the one affordance named in the rejection, and each round the board
 * came back having tried the *next* control on the same screen. The reviewer
 * never leaves the default `canvas` screen and never opens the protobar tabs
 * (board-reviews-only-default-canvas-screen), so anything that renders a grab
 * cursor, a pointer cursor, or a button role there is something they may press —
 * and anything that answers a press with no observable change reads to them as
 * "broken", whatever the spec says.
 *
 * So this probe does not check a named fix. It enumerates what *looks*
 * interactive on the boot screen and asks each one the reviewer's question: I
 * pressed it — did anything happen?
 *
 * What counts as "something happened" is deliberately broad, because the intent
 * is to clear affordances, not to assert a particular behaviour: any DOM
 * mutation under #stage, any screen change, any change to the model's node set,
 * or any change in the element's own class list. An affordance that produces
 * none of those under a real press is reported as dead.
 *
 * Two gestures are driven per element, because they fail independently and the
 * board has hit both:
 *   activate — pointerdown/pointerup/click on the element itself.
 *   carry    — press on the element, move to open canvas, release there. The
 *              click is dispatched where the UA would actually put it (the
 *              nearest common ancestor), not on the source (a-click-is-not-a-drag).
 *
 * Everything is measured on `canvas` as the page boots it. The probe never
 * bounces through another screen first: the library and the node layer are
 * re-rendered per screen, so a bounce measures a different DOM than the one the
 * reviewer is looking at.
 */
(function () {
  var out = [];
  var fails = 0;
  var stage = document.querySelector('#stage');

  function screenNow() { return stage.dataset.screen; }

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

  function commonAncestor(a, b) {
    for (var n = a; n; n = n.parentElement) if (n.contains(b)) return n;
    return document.body;
  }

  /* A fingerprint of everything the reviewer could see change.

     Deliberately whole-document rather than "#stage innerHTML length", which an
     earlier revision used and which is blind to most of the ways this prototype
     responds: a zoom that only writes a transform, a panel collapse that toggles
     a class on a container outside #stage, a filter that swaps equal-length
     text, a press that only moves focus. Under that narrower fingerprint five of
     the eight controls it flagged were live. Hash the serialized body, and carry
     focus and scroll alongside it — a caret appearing and a list scrolling are
     both "something happened" to the person pressing.

     Node identity is by position so a node that merely *moves* registers. */
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h;
  }

  function snapshot() {
    var nodes = 'unreachable';
    try {
      nodes = wiring.nodes.map(function (n) {
        return n.id + '@' + Math.round(n.x) + ',' + Math.round(n.y);
      }).sort().join('|');
    } catch (e) { /* screens without the wiring model */ }
    var scrolls = [].slice.call(document.querySelectorAll('*')).map(function (el) {
      return el.scrollTop + ',' + el.scrollLeft;
    }).join('|');
    var a = document.activeElement;
    return {
      screen: screenNow(),
      nodes: nodes,
      dom: hash(document.body.outerHTML),
      focus: a ? (a.tagName + '#' + (a.id || '') + '.' + (typeof a.className === 'string' ? a.className : '')) : 'none',
      scroll: hash(scrolls)
    };
  }

  function changed(a, b) {
    return a.screen !== b.screen || a.nodes !== b.nodes || a.dom !== b.dom
      || a.focus !== b.focus || a.scroll !== b.scroll;
  }

  function label(el) {
    var name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
      .replace(/\s+/g, ' ').trim();
    return (el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '')
      + ' "' + (name ? name.slice(0, 44) : '<no accessible name>') + '"');
  }

  /* Visible, inside the viewport, big enough to hit. An offscreen control is not
     something the reviewer can press, and reporting it as dead would be noise. */
  function reachable(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
    if (r.right <= 0 || r.left >= window.innerWidth) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none';
  }

  /* Presents as interactive to a mouse operator: a hand or grab cursor, a
     button/link role, or an explicit drag source. Cursor is the honest signal —
     it is what the reviewer's pointer told them before they pressed. */
  function affordances() {
    var all = [].slice.call(stage.querySelectorAll('*'));
    return all.filter(function (el) {
      if (!reachable(el)) return false;
      var cs = getComputedStyle(el);
      var semantic = el.getAttribute('draggable') === 'true'
        || el.getAttribute('role') === 'button'
        || el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT';
      if (/pointer|grab/.test(cs.cursor)) {
        /* Only the outermost element of a cursor run: a button and its label
           span both compute `pointer`, and pressing the label is pressing the
           button. Reporting both would double-count one affordance.

           A control with its own semantics is never collapsed into its parent,
           though. An earlier revision of this probe did that and reported the
           document-switcher chip as dead while silently skipping the real Save
           button inside it — dedup that hides the control under test is worse
           than a duplicate line of output. */
        if (semantic) return true;
        var p = el.parentElement;
        if (p && p !== stage && stage.contains(p) && /pointer|grab/.test(getComputedStyle(p).cursor)) return false;
        return true;
      }
      return semantic;
    });
  }

  var openPoint = (function () {
    var lib = document.querySelector('#library');
    var sr = stage.getBoundingClientRect();
    var lr = lib ? lib.getBoundingClientRect() : { right: sr.left };
    return { x: (lr.right + sr.right) / 2, y: sr.top + sr.height / 2 };
  })();

  var list = affordances();
  out.push('screen at boot: ' + screenNow() + ' | viewport ' + window.innerWidth + 'x' + window.innerHeight);
  out.push('reachable affordances on this screen: ' + list.length);
  if (!list.length) {
    out.push('FAIL nothing on the reviewed screen presents as interactive — the selector set is vacuous');
    return out.push('FAIL 1 check(s)'), out.join('\n');
  }

  /* Two classes of control answer a synthetic press with nothing and are not
     defective. Both are reported rather than dropped, so the reader can see what
     the probe declined to judge instead of trusting a silent filter.

     unjudgeable — a text field. Dispatched events do not move focus, so this
                   probe cannot see the one thing a real click on an input does.
     by-design   — a toggle that is already in the state it selects. Pressing
                   "Any state" when the filter is already "any" correctly
                   re-renders to an identical DOM. */
  function excuse(el) {
    var t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable) {
      return 'unjudgeable: a dispatched press cannot move focus, and focus is what a real click here does';
    }
    if (el.getAttribute('aria-pressed') === 'true' || el.classList.contains('on')) {
      return 'by design: already the selected state, so re-selecting it changes nothing';
    }
    return null;
  }

  var dead = [];
  var excused = [];
  list.forEach(function (el) {
    if (!stage.contains(el)) return; /* detached by an earlier activation */
    var r = el.getBoundingClientRect();
    var from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };

    var before = snapshot();
    var classBefore = el.className;
    fire(el, 'pointerdown', from.x, from.y);
    fire(el, 'mousedown', from.x, from.y);
    fire(el, 'pointerup', from.x, from.y);
    fire(el, 'mouseup', from.x, from.y);
    fire(el, 'click', from.x, from.y);
    var afterActivate = snapshot();
    var activated = changed(before, afterActivate) || el.className !== classBefore;

    /* Back to the reviewed screen if this control navigated, so the carry is
       measured on `canvas` like everything else. */
    if (screenNow() !== before.screen) go(before.screen);

    var carried = false;
    if (stage.contains(el)) {
      var b2 = snapshot();
      fire(el, 'pointerdown', from.x, from.y);
      fire(el, 'mousedown', from.x, from.y);
      var mid = { x: (from.x + openPoint.x) / 2, y: (from.y + openPoint.y) / 2 };
      var t1 = document.elementFromPoint(mid.x, mid.y) || stage;
      fire(t1, 'pointermove', mid.x, mid.y);
      fire(t1, 'mousemove', mid.x, mid.y);
      var t2 = document.elementFromPoint(openPoint.x, openPoint.y) || stage;
      fire(t2, 'pointermove', openPoint.x, openPoint.y);
      fire(t2, 'mousemove', openPoint.x, openPoint.y);
      fire(t2, 'pointerup', openPoint.x, openPoint.y);
      fire(t2, 'mouseup', openPoint.x, openPoint.y);
      fire(commonAncestor(el, t2), 'click', openPoint.x, openPoint.y);
      carried = changed(b2, snapshot());
      if (screenNow() !== b2.screen) go(b2.screen);
    }

    var isDragSource = el.getAttribute('draggable') === 'true'
      || /grab/.test(getComputedStyle(el).cursor);
    if (!activated && !carried) {
      var why = excuse(el);
      if (why) excused.push({ el: el, why: why });
      else dead.push({ el: el, drag: isDragSource, empty: !el.querySelector('button, a, input, [role="button"], [tabindex]') });
    }
  });

  /* The counterfactual that keeps a FAIL meaningful: if the detector were
     simply blind to this page's responses it would flag all 34. The live count
     is what says the five below are findings and not detector artifacts. */
  out.push('');
  out.push('answered a press with an observable change: '
    + (list.length - dead.length - excused.length) + '/' + list.length);

  out.push('');
  if (dead.length) {
    out.push('DEAD AFFORDANCES — these render as pressable on the reviewed screen and answer a press with nothing:');
    dead.forEach(function (d) {
      out.push('  ' + (d.drag ? '[drag-cursor] ' : '[pointer-cursor] ') + label(d.el)
        + (d.empty ? ' — dead everywhere: it holds no interactive child either'
                   : ' — dead here: the live control is a child, so the surrounding hand cursor over-promises'));
    });
    fails += dead.length;
  } else {
    out.push('ok every reachable affordance on the reviewed screen answers a press with an observable change');
  }

  if (excused.length) {
    out.push('');
    out.push('not counted (silent by nature, not by defect):');
    excused.forEach(function (d) { out.push('  ' + label(d.el) + ' — ' + d.why); });
  }

  out.push('');
  out.push(fails
    ? 'FAIL ' + fails + ' dead affordance(s) on the screen the board reviews'
    : 'PASS no dead affordances on the screen the board reviews');
  return out.join('\n');
})()
