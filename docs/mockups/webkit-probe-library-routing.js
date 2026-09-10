/* WebKit probe — the board's exact gesture, in the board's engine.
 *
 *   swift docs/mockups/verify-webkit.swift \
 *     docs/mockups/prototype-standalone.html \
 *     --eval docs/mockups/webkit-probe-library-routing.js
 *
 * Point it at a standalone built from cd5e162 (option (a) alone) and it FAILS:
 * a desktop click on a canvas-screen library row leaves screen=canvas with no
 * ghost — nothing visible happens at all, because that build's only non-wiring
 * feedback was announce() into a .visually-hidden live region. That pairing is
 * the evidence the routing in activateLibRow() is load-bearing rather than
 * decorative; keep both halves when re-running.
 *
 * Note `wiring` is a top-level `let`, not a window property, so it is read
 * through a bare reference in try/catch — `window.wiring` reads undefined and
 * silently scores a pass as a failure.
 *
 * The cursor expectations inverted at 6e87d28 and the counts below are real
 * assertions, not annotations. Before it, a canvas row was `pointer` because a
 * click was all it could serve; now `bindLibraryCarry()` makes every usable row
 * draggable by hand on every screen, so the row shows `grab` wherever it
 * renders. `draggable="true"` still stays scoped to where drop is wired — the
 * look follows the carry, the attribute follows the drop wiring. Until 6e87d28
 * these lines printed a bare `(want …)` next to an unconditional PASS, so a
 * mismatch read as green; the verdict now counts them.
 */
(function () {
  var out = [];
  function snap() {
    return {
      screen: document.querySelector('#stage').dataset.screen,
      placing: (function () { try { return !!wiring.placing; } catch (e) { return 'unreachable'; } })(),
      ghosts: document.querySelectorAll('#edgeLabels .wire-ghost').length
    };
  }
  go('canvas');
  var rows = [].slice.call(document.querySelectorAll('#libGroups .lib-row[data-res]'));
  var draggable = rows.filter(function (r) {
    return r.getAttribute('draggable') === 'true'; }).length;
  var grab = rows.filter(function (r) {
    return getComputedStyle(r).cursor === 'grab'; }).length;
  var pointer = rows.filter(function (r) {
    return getComputedStyle(r).cursor === 'pointer'; }).length;
  var fails = 0;
  function want(label, got, expected) {
    var ok = got === expected;
    if (!ok) fails++;
    out.push((ok ? 'ok   ' : 'FAIL ') + label + ': ' + got + ' (want ' + expected + ')');
  }
  out.push('canvas usable rows: ' + rows.length);
  want('draggable on canvas', draggable, 0);
  want('grab cursors on canvas', grab, rows.length);
  want('pointer cursors on canvas', pointer, 0);

  var before = snap();
  rows[0].click();
  var after = snap();
  out.push('BEFORE click: ' + JSON.stringify(before));
  out.push('AFTER  click: ' + JSON.stringify(after));
  if (!(before.screen === 'canvas' && after.screen === 'wiring'
        && after.placing && after.ghosts === 1)) {
    fails++;
    out.push('FAIL desktop click on canvas did not place anything');
  } else {
    out.push('ok   desktop click on canvas routed to wiring and armed a visible ghost');
  }
  out.push(fails ? 'FAIL ' + fails + ' check(s)' : 'PASS click path and canvas affordance both hold');
  return out.join('\n');
})()
