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
  out.push('canvas usable rows: ' + rows.length);
  out.push('draggable on canvas: ' + rows.filter(function (r) {
    return r.getAttribute('draggable') === 'true'; }).length + ' (want 0)');
  out.push('grab cursors on canvas: ' + rows.filter(function (r) {
    return getComputedStyle(r).cursor === 'grab'; }).length + ' (want 0)');
  out.push('pointer cursors on canvas: ' + rows.filter(function (r) {
    return getComputedStyle(r).cursor === 'pointer'; }).length + ' (want ' + rows.length + ')');

  var before = snap();
  rows[0].click();
  var after = snap();
  out.push('BEFORE click: ' + JSON.stringify(before));
  out.push('AFTER  click: ' + JSON.stringify(after));
  var routed = before.screen === 'canvas' && after.screen === 'wiring'
    && after.placing && after.ghosts === 1;
  out.push(routed ? 'PASS desktop click on canvas routed to wiring and armed a visible ghost'
                  : 'FAIL desktop click on canvas did not place anything');
  return out.join('\n');
})()
