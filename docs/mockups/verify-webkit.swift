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

import Cocoa
import WebKit

let argv = CommandLine.arguments
guard argv.count > 1 else {
    FileHandle.standardError.write("usage: verify-webkit <path-to-html> [--eval <file.js>]\n".data(using: .utf8)!)
    exit(2)
}
let target = URL(fileURLWithPath: argv[1]).standardizedFileURL

var evalScript: String?
if let i = argv.firstIndex(of: "--eval"), i + 1 < argv.count {
    evalScript = try? String(contentsOfFile: argv[i + 1], encoding: .utf8)
    if evalScript == nil {
        FileHandle.standardError.write("could not read --eval script\n".data(using: .utf8)!)
        exit(2)
    }
}

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
    private let webView: WKWebView
    private let custom: String?

    init(custom: String?) {
        self.custom = custom
        // Layout has to be real: a zero-sized frame can short-circuit style resolution.
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 1000),
                            configuration: WKWebViewConfiguration())
        super.init()
        webView.navigationDelegate = self
    }

    func run(_ url: URL) {
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func webView(_ wv: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        failure = "navigation failed: \(error.localizedDescription)"; done = true
    }

    func webView(_ wv: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        failure = "provisional navigation failed: \(error.localizedDescription)"; done = true
    }

    func webView(_ wv: WKWebView, didFinish nav: WKNavigation!) {
        // Let the prototype's own boot scripts build the library and canvas.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            if let custom = self.custom {
                wv.evaluateJavaScript(custom) { result, error in
                    if let error = error { self.failure = "eval failed: \(error.localizedDescription)" }
                    else { self.evaluated = String(describing: result ?? "null") }
                    self.done = true
                }
                return
            }
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

let probe = Probe(custom: evalScript)
probe.run(target)

let deadline = Date().addingTimeInterval(45)
while !probe.done && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
}

if let failure = probe.failure {
    FileHandle.standardError.write("ERROR: \(failure)\n".data(using: .utf8)!)
    exit(1)
}

if evalScript != nil {
    print(probe.evaluated ?? "null")
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
