// TNG-127: verify the drag-vs-selection invariant in the engine that broke.
//
// Why this file exists at all
// ---------------------------
// verify-prototype.mjs drives headless Chrome. Chromium's UA stylesheet already
// forces `user-select: none` on [draggable="true"] and its descendants, so the
// library rows reported "none" even when the prototype declared `user-select`
// nowhere. That is why five consecutive self-checks passed while the board — on
// Safari — could not drag an agent out of the library at all: pressing on
// selectable text inside a draggable element starts a *text selection* in
// WebKit, and the drag never arms.
//
// A Chrome-only gate cannot see that class of bug, so this harness loads the
// shipped standalone into a real WKWebView (the same WebKit Safari uses) and
// probes it twice:
//
//   pass A — as shipped: every drag surface must compute user-select: none,
//            and genuine content must still be selectable.
//   pass B — author rule defeated: the same surfaces must go selectable again.
//
// Pass B is the counterfactual headless Chrome physically cannot produce. It
// reproduces the pre-fix state and proves WebKit has no UA fallback, so the
// author rule is load-bearing rather than decorative. If someone deletes the
// rule later, pass A fails; if someone "fixes" pass A by leaning on a UA sheet
// that does not exist in WebKit, pass B fails.
//
// Build and run:
//   swiftc -O verify-webkit.swift -o /tmp/verify-webkit
//   /tmp/verify-webkit prototype-standalone.html
//
// `--eval <file.js>` evaluates a script against the loaded page and prints the
// result instead of asserting — for surveying the DOM when selectors drift.
//
// `--eval-async <file.js>` is the same, for a probe whose IIFE is `async` and
// has to await something the page does on a callback. The command exits 1 when
// a probe's own output contains `FAIL`, so a probe that reports failures can
// actually fail the run.
//
// `--shot <out.png>` writes a PNG of the loaded page, after `--eval` has run if
// both are given. The board reviews in Safari, so a picture offered as evidence
// should come out of the engine they are looking at rather than out of Chrome.
//
// LIMIT — this view renders offscreen, so the animation clock never advances.
// Measured from inside the page: 0 requestAnimationFrame callbacks in a full
// second. Nothing here is a bug in the artifact, but two things follow, and
// both have already produced a false finding:
//
//   1. A transitioned property is frozen at its from-value permanently. The
//      stage cross-fades `background-color` over 240 ms, so reading it after a
//      scripted theme change reports the *previous* ground no matter how long
//      the probe waits. That is the real reason a scripted light theme looks
//      near-black here — not a stale rasterization tile, which is what this
//      comment used to say. Chrome resolves the identical flip correctly at
//      t=600 ms, and suppressing the transition resolves it here immediately.
//      Measure theme tokens (`--color-ground`), or suppress the transition
//      first; never sample a transitioned paint.
//   2. Declared animation values are still trustworthy, because they are style,
//      not timeline: `animation-name`, `animation-iteration-count` and
//      `animation-play-state` all read correctly. Reduced-motion coverage is
//      therefore measurable here, and that is how the `[data-motion="reduce"]`
//      gap on the run screens was found.

import Cocoa
import WebKit

let argv = CommandLine.arguments
guard argv.count > 1 else {
    FileHandle.standardError.write("usage: verify-webkit <path-to-html> [--eval <file.js>]\n".data(using: .utf8)!)
    exit(2)
}
// A `#fragment` on the path is passed through to the page, so a snapshot can
// select its screen and theme at load — e.g. `…/prototype-standalone.html#wiring,light`.
//
// This matters more than it looks. An offscreen WKWebView rasterizes the stage
// as one large tile, and a theme changed *after* load by script repaints the
// panels in the snapshot while the canvas ground comes back from the stale tile
// — a light-mode screenshot with a near-black canvas, which reads as a broken
// theme and is not one (the DOM measures `#stage` at the correct light value
// throughout). Choosing the theme in the fragment means it is correct at first
// paint and there is no repaint to miss.
let rawTarget = argv[1]
let fragment = rawTarget.firstIndex(of: "#").map { String(rawTarget[rawTarget.index(after: $0)...]) }
let filePart = fragment == nil ? rawTarget : String(rawTarget[..<rawTarget.firstIndex(of: "#")!])
var target = URL(fileURLWithPath: filePart).standardizedFileURL
if let fragment = fragment,
   var parts = URLComponents(url: target, resolvingAgainstBaseURL: false) {
    parts.fragment = fragment
    if let withFragment = parts.url { target = withFragment }
}

var evalScript: String?
if let i = argv.firstIndex(of: "--eval"), i + 1 < argv.count {
    evalScript = try? String(contentsOfFile: argv[i + 1], encoding: .utf8)
    if evalScript == nil {
        FileHandle.standardError.write("could not read --eval script\n".data(using: .utf8)!)
        exit(2)
    }
}

// `--eval-async` is `--eval` for a probe that has to wait for the prototype.
//
// `evaluateJavaScript` hands back whatever the expression evaluates to *now*.
// Give it a promise and it reports the promise, not the value — so a probe
// written against an asynchronous path (`saveAndRun` writes the document and
// only then creates the run, via a `doSave` callback) either reads the state
// before the write lands or has to assert on a timer and hope. Both of those
// produce a green probe on a build that never saved.
//
// `callAsyncJavaScript` runs the script as an async function body and resolves
// the promise before returning, which is the only way to assert "the write
// happened *before* the run was created" in WebKit. It takes a function body
// rather than an expression, hence the `return await (...)` wrap: the probe
// file stays an ordinary IIFE and is still readable on its own.
var asyncScript: String?
if let i = argv.firstIndex(of: "--eval-async"), i + 1 < argv.count {
    asyncScript = try? String(contentsOfFile: argv[i + 1], encoding: .utf8)
    if asyncScript == nil {
        FileHandle.standardError.write("could not read --eval-async script\n".data(using: .utf8)!)
        exit(2)
    }
}

var shotPath: String?
if let i = argv.firstIndex(of: "--shot"), i + 1 < argv.count { shotPath = argv[i + 1] }

// Drag surfaces: the app shell, the library row labels the board pressed on,
// and the canvas node labels the rejection screenshot showed selection smearing
// across. Selectors are asserted non-empty below so a rename cannot silently
// turn these checks into vacuous truths.
let probeJS = """
(() => {
  const sel = (el) => { const cs = getComputedStyle(el); return cs.webkitUserSelect || cs.userSelect; };
  const stage = document.querySelector('#stage');
  const optIns = ['.rr-body', '.ent-out', '.story-prompt .rt-body', '.cite', '.input', 'input', 'textarea']
    .flatMap((q) => [...document.querySelectorAll('#stage ' + q)]);
  const library = [...document.querySelectorAll('#libGroups .lib-row-name, #libGroups .lib-row-sub')];
  const nodeLabels = [...document.querySelectorAll('#nodes .node-name, #nodes .node-top, #nodes .w-name, #nodes .w-top')];
  return JSON.stringify({
    stage: stage ? sel(stage) : 'MISSING',
    libraryTotal: library.length,
    librarySelectable: library.filter((n) => sel(n) !== 'none').length,
    nodeLabelTotal: nodeLabels.length,
    nodeLabelsSelectable: nodeLabels.filter((n) => sel(n) !== 'none').length,
    optInTotal: optIns.length,
    optInsLocked: optIns.filter((el) => sel(el) === 'none').length
  });
})()
"""

// Reproduce the pre-fix prototype: no #stage lock at all, so every descendant
// falls back to whatever the engine's default is.
let defeatJS = """
(() => {
  const s = document.createElement('style');
  s.textContent = '#stage { -webkit-user-select: auto !important; user-select: auto !important; }';
  document.head.appendChild(s);
  return 'ok';
})()
"""

final class Probe: NSObject, WKNavigationDelegate {
    var done = false
    var failure: String?
    var shipped: String?
    var defeated: String?
    var evaluated: String?
    var shotWritten: String?
    private let webView: WKWebView
    private let custom: String?
    private let asyncCustom: String?
    private let shot: String?

    init(custom: String?, asyncCustom: String? = nil, shot: String?) {
        self.custom = custom
        self.asyncCustom = asyncCustom
        self.shot = shot
        // Layout has to be real: a zero-sized frame can short-circuit style resolution.
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 1000),
                            configuration: WKWebViewConfiguration())
        super.init()
        webView.navigationDelegate = self
    }

    func run(_ url: URL) {
        // loadFileURL drops the fragment, so a fragment target goes through
        // loadSimulatedRequest with the file read in directly.
        if url.fragment != nil, let html = try? String(contentsOf: url, encoding: .utf8) {
            webView.loadHTMLString(html, baseURL: url)
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func webView(_ wv: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        failure = "navigation failed: \(error.localizedDescription)"; done = true
    }

    func webView(_ wv: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        failure = "provisional navigation failed: \(error.localizedDescription)"; done = true
    }

    /* Settle before the snapshot, generously. #stage cross-fades its background
       and colour on a theme change, and getComputedStyle — or a camera — during
       that transition returns the *interpolated* value. A 0.6s wait caught the
       cross-fade mid-flight and produced a light-theme screenshot with a
       near-black canvas, which reads as a broken theme and is not one. */
    private func capture(_ wv: WKWebView) {
        guard let path = shot else { done = true; return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            wv.takeSnapshot(with: nil) { image, error in
                defer { self.done = true }
                if let error = error { self.failure = "snapshot failed: \(error.localizedDescription)"; return }
                guard let image = image,
                      let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else {
                    self.failure = "snapshot produced no image"; return
                }
                do { try png.write(to: URL(fileURLWithPath: path)); self.shotWritten = path }
                catch { self.failure = "could not write \(path): \(error.localizedDescription)" }
            }
        }
    }

    func webView(_ wv: WKWebView, didFinish nav: WKNavigation!) {
        // Let the prototype's own boot scripts build the library and canvas.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            if let asyncCustom = self.asyncCustom {
                wv.callAsyncJavaScript("return await (\(asyncCustom))",
                                       arguments: [:], in: nil, in: .page) { result in
                    switch result {
                    case .success(let value): self.evaluated = String(describing: value)
                    case .failure(let error):
                        // localizedDescription is just "A JavaScript exception
                        // occurred", which cannot be debugged. The real message
                        // and line are in the WKError userInfo.
                        let info = (error as NSError).userInfo
                        let detail = [info["WKJavaScriptExceptionMessage"],
                                      info["WKJavaScriptExceptionLineNumber"],
                                      info["WKJavaScriptExceptionColumnNumber"]]
                            .compactMap { $0.map { "\($0)" } }
                            .joined(separator: " @ ")
                        self.failure = "async eval failed: "
                            + (detail.isEmpty ? error.localizedDescription : detail)
                    }
                    if self.shot != nil { self.capture(wv) } else { self.done = true }
                }
                return
            }
            if let custom = self.custom {
                wv.evaluateJavaScript(custom) { result, error in
                    if let error = error { self.failure = "eval failed: \(error.localizedDescription)" }
                    else { self.evaluated = String(describing: result ?? "null") }
                    if self.shot != nil { self.capture(wv) } else { self.done = true }
                }
                return
            }
            if self.shot != nil { self.capture(wv); return }
            wv.evaluateJavaScript(probeJS) { result, error in
                if let error = error {
                    self.failure = "pass A failed: \(error.localizedDescription)"; self.done = true; return
                }
                self.shipped = result as? String
                wv.evaluateJavaScript(defeatJS) { _, error in
                    if let error = error {
                        self.failure = "defeat injection failed: \(error.localizedDescription)"; self.done = true; return
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        wv.evaluateJavaScript(probeJS) { result, error in
                            if let error = error { self.failure = "pass B failed: \(error.localizedDescription)" }
                            else { self.defeated = result as? String }
                            self.done = true
                        }
                    }
                }
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let probe = Probe(custom: evalScript, asyncCustom: asyncScript, shot: shotPath)
probe.run(target)

// An async probe spends real time inside the page (it waits on the document
// write, and drives a dozen screens), so it gets a longer leash than the
// synchronous selection passes this harness was written for.
let deadline = Date().addingTimeInterval(asyncScript != nil ? 180 : 45)
while !probe.done && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
}

if let failure = probe.failure {
    FileHandle.standardError.write("ERROR: \(failure)\n".data(using: .utf8)!)
    exit(1)
}

if evalScript != nil || asyncScript != nil || shotPath != nil {
    if let out = probe.evaluated { print(out) }
    if let written = probe.shotWritten { print("wrote \(written)") }
    // A probe that reports its own failures has to be able to fail the command,
    // otherwise a red run is indistinguishable from a green one in CI.
    //
    // Matched per line rather than as a substring: the probe quotes page text
    // back as evidence, and one of the capture cards legitimately reads
    // "… 15S · FAILED", which a naive `contains("FAIL")` scored as a failure on
    // a run where all 39 checks passed.
    if let out = probe.evaluated,
       out.split(separator: "\n").contains(where: {
           $0.trimmingCharacters(in: .whitespaces).hasPrefix("FAIL ")
       }) {
        exit(1)
    }
    exit(0)
}

guard let shippedRaw = probe.shipped, let defeatedRaw = probe.defeated else {
    FileHandle.standardError.write("ERROR: probe timed out after 45s\n".data(using: .utf8)!)
    exit(1)
}

func decode(_ s: String, _ label: String) -> [String: Any] {
    guard let d = s.data(using: .utf8),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
        FileHandle.standardError.write("ERROR: could not decode \(label)\n".data(using: .utf8)!)
        exit(1)
    }
    return o
}

let a = decode(shippedRaw, "pass A")
let b = decode(defeatedRaw, "pass B")
func int(_ o: [String: Any], _ k: String) -> Int { (o[k] as? Int) ?? -1 }
func str(_ o: [String: Any], _ k: String) -> String { (o[k] as? String) ?? "?" }

var failures: [String] = []
func check(_ ok: Bool, _ message: String) {
    print("  \(ok ? "ok  " : "FAIL") \(message)")
    if !ok { failures.append(message) }
}

print("engine: WebKit / WKWebView (the engine Safari uses)")
print("pass A — as shipped:")
check(str(a, "stage") == "none",
      "app shell locks selection (stage = \(str(a, "stage")))")
check(int(a, "libraryTotal") > 0 && int(a, "librarySelectable") == 0,
      "library row labels unselectable (\(int(a, "librarySelectable"))/\(int(a, "libraryTotal")) selectable)")
check(int(a, "nodeLabelTotal") > 0 && int(a, "nodeLabelsSelectable") == 0,
      "canvas node labels unselectable (\(int(a, "nodeLabelsSelectable"))/\(int(a, "nodeLabelTotal")) selectable)")
check(int(a, "optInTotal") > 0 && int(a, "optInsLocked") == 0,
      "answer/output/fields still selectable (\(int(a, "optInsLocked"))/\(int(a, "optInTotal")) wrongly locked)")

print("pass B — author rule defeated (reproduces the pre-fix state):")
check(str(b, "stage") != "none",
      "shell goes selectable again (stage = \(str(b, "stage")))")
check(int(b, "libraryTotal") > 0 && int(b, "librarySelectable") == int(b, "libraryTotal"),
      "library labels go selectable — WebKit has no UA fallback, so the rule is load-bearing "
      + "(\(int(b, "librarySelectable"))/\(int(b, "libraryTotal")) selectable)")

if failures.isEmpty {
    print("\nWEBKIT OK — drag surfaces locked, content still copyable, fix proven load-bearing")
    exit(0)
}
FileHandle.standardError.write("\nWEBKIT FAILED — \(failures.count) check(s)\n".data(using: .utf8)!)
exit(1)
