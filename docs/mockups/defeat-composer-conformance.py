#!/usr/bin/env python3
"""§10.6 — audit `verify-composer-conformance.mjs` now that its rows are green.

`mutate-composer-conformance.py` proved the gate's thirteen rows were detectable while
they were still open: it applied the eight fixes to a scratch copy and reverted them one
at a time. Those fixes have landed (TNG-193/TNG-194), so its patch anchors are gone and it
answers `CANNOT RUN`. That is the correct answer to the wrong question — the question after
a gate goes green is the other one:

    a gate that just went green hides false passes.

So this harness runs the surviving direction, for every row the gate prints rather than a
list hardcoded here:

  1. Read the baseline. Rows already red are reported and skipped — they cannot be
     *made* to fail, so nothing about them can be measured here.
  2. Defeat one row at a time in a scratch copy of the gate's inputs, restoring the exact
     defect §10 recorded, and require the failing set to grow by **exactly** that row.

A row that survives its own defect is not a contract: it is a check that cannot fail. A
defeat that reddens a second row means the two rows are not independent and one of them is
scoring the other's work.

`ui/` and `crates/` are never written. Everything happens in a scratch copy.

  python3 docs/mockups/defeat-composer-conformance.py

Exit 0 = every green row is individually detectable, 1 = a row cannot fail, is not
independent, or has no defeat defined here, 2 = the harness could not run (an anchor
drifted with the source, so the answer would be about this file rather than the gate).
"""
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
GATE = REPO / 'docs/mockups/verify-composer-conformance.mjs'

COMPOSER = 'ui/src/components/composer/Composer.tsx'
WORKSPACE = 'ui/src/components/Workspace.tsx'
CSS = 'ui/src/styles/runtime.css'
RUNS = 'ui/src/lib/runs/client.ts'
TEAM = 'ui/src/lib/team-file/client.ts'
BACKEND = 'crates/loomwatch-backend/src/runs.rs'
INPUTS = [COMPOSER, WORKSPACE, CSS, RUNS, TEAM, BACKEND]

# One defeat per row: the defect §10 recorded, restored. Each entry is a list of
# (file, pattern, replacement) regex substitutions that must each match exactly once —
# a pattern that matches twice is as much an anchor failure as one that matches never,
# because the second hit is somewhere this harness never looked.
DEFEATS = {
    # §1.2 — the global handler stops testing the modifier, so ⌘↵ outside the textarea
    # falls through to the bare `Enter` branch and offers a rename instead of a run.
    'C1': [(WORKSPACE, r"if \(mod && event\.key === 'Enter'\)", "if (event.shiftKey && event.key === 'Enter')")],
    # §1.2 — the height effect goes back to keying on the text alone, so blur never collapses it.
    'C2': [(COMPOSER, r"\n\s*if \(!focused\) \{ element\.style\.height = ''; return \}", ''),
           (COMPOSER, r"\}, \[value, focused\]\)", '}, [value])')],
    # §1.1 — the six-line cap returns. The gate derives 5 lines from the rule's own
    # line-height, so this has to move the cap, not the type scale.
    'C3': [(CSS, r"max-height: 100px; padding: 0; margin: 0; display: block;",
            'max-height: 120px; padding: 0; margin: 0; display: block;'),
           (COMPOSER, r"Math\.min\(100,", 'Math.min(120,')],
    # §1.3 — the blocker goes back to a count with no names.
    'C4': [(WORKSPACE, r"This one has \$\{terminals\}: \$\{terminalIds\.map\(\(id\) => nodeNames\.get\(id\) \?\? id\)\.join\(', '\)\}\.",
            'This one has ${terminals}.')],
    # §1.3 — [ Show on canvas ] goes back to framing the canvas and selecting nothing.
    'C5': [(WORKSPACE, r"run: \(\) => \{ doc\.onNodesChange\(doc\.nodes\.map\(\(node\) => \(\{ id: node\.id, type: 'select' as const, selected: terminalIds\.includes\(node\.id\) \}\)\)\)",
            'run: () => { void 0')],
    # §1.4/§1.6 — run creation reports the save that is not happening, and `Starting…` is
    # unreachable again.
    'C6': [(WORKSPACE, r"if \(starting\) return \{ kind: 'starting' \}", "if (starting) return { kind: 'saving', filename }")],
    # §1.6 — the start key leaves the request body, so a lost response can only be re-posted.
    'C7': [(RUNS, r"body: JSON\.stringify\(\{ teamPath, prompt, startKey, expectedRevision \}\)",
            'body: JSON.stringify({ teamPath, prompt, expectedRevision })'),
           (RUNS, r"\{ startKey, expectedRevision, signal \}: StartRunOptions", '{ expectedRevision, signal }: StartRunOptions')],
    # §1.4 — the save half stops being conditional on the revision the operator loaded.
    'C8': [(TEAM, r"'If-Match'", "'X-Match'")],
    # §1.4/§1.5 — nothing binds the run to the bytes the PUT wrote.
    'C9': [(RUNS, r"body: JSON\.stringify\(\{ teamPath, prompt, startKey, expectedRevision \}\)",
            'body: JSON.stringify({ teamPath, prompt, startKey })'),
           (RUNS, r"\{ startKey, expectedRevision, signal \}: StartRunOptions", '{ startKey, signal }: StartRunOptions'),
           (WORKSPACE, r"await launch\(prompt, parent, doc\.currentRevision\(\)\)", 'await launch(prompt, parent)')],
    # §1.4/§1.5 daemon half — the field stops being declared, so the client's value is ignored.
    'C9-B': [(BACKEND, r"expected_revision: Option<String>", 'expected_revision: Option<std::string::String>')],
    # §11.6 f22 — hiding the composer below 768 satisfies §1.1's superseded row by failing this one.
    'C10': [(CSS, r"\.lw-composer \{ width: calc\(100vw - 2 \* var\(--lw-panel-inset\)\); \}",
             '.lw-composer { display: none; width: calc(100vw - 2 * var(--lw-panel-inset)); }')],
    # §1.7 — a second source of run configuration appears next to the goal.
    'C11': [(COMPOSER, r'<div className="comp-mid">', '<div className="comp-mid"><input type="range" aria-label="temperature" />')],
    # §1.4 — a failed save no longer stops the run.
    'C12': [(WORKSPACE, r"if \(!saved\) \{ setStartError\('The team file could not be saved, so no run was started\.'\); return \}",
             "if (!saved) setStartError('could not save')")],
    # §1.5 — the prompt is cleared before a run id exists, so a file race loses a typed goal.
    'C13': [(WORKSPACE, r"const parent = activeRunId", "setComposerText('')\n    const parent = activeRunId")],
}


def cannot_run(message):
    print(f'CANNOT RUN — {message}')
    sys.exit(2)


def stage(root):
    for rel in INPUTS:
        source = REPO / rel
        if not source.exists():
            cannot_run(f'the shipped input is missing: {rel}')
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(source, target)


def defeat(root, row):
    for rel, pattern, replacement in DEFEATS[row]:
        path = root / rel
        text = path.read_text()
        hits = len(re.findall(pattern, text))
        if hits != 1:
            cannot_run(f'{row}: the defeat anchor matched {hits} times (expected 1) in {rel}: {pattern}\n'
                       '    The source moved under this harness. Re-anchor it before trusting any result —\n'
                       '    a defeat that does not apply reads exactly like a row that cannot fail.')
        path.write_text(re.sub(pattern, replacement, text, count=1))


def run_gate(root=None):
    import os
    env = dict(os.environ)
    if root is not None:
        env['LOOMWATCH_ROOT'] = str(root)
    result = subprocess.run(['node', str(GATE)], capture_output=True, text=True, env=env)
    if result.returncode == 2:
        cannot_run(f'the gate could not answer:\n{result.stderr.strip()}')
    rows = re.findall(r'^(?:PASS|FAIL)\s+(\S+)', result.stdout, re.M)
    failed = set(re.findall(r'^FAIL\s+(\S+)', result.stdout, re.M))
    score = re.search(r'(\d+)/(\d+) contracts met', result.stdout)
    if not rows or not score:
        cannot_run('the gate printed no rows or no score line')
    return rows, failed, f'{score.group(1)}/{score.group(2)}'


def main():
    if not GATE.exists():
        cannot_run(f'the gate is missing: {GATE}')
    problems = []
    with tempfile.TemporaryDirectory(prefix='loomwatch-composer-defeat-') as tmp:
        tmp = pathlib.Path(tmp)

        base = tmp / 'baseline'
        stage(base)
        rows, baseline, score = run_gate(base)
        print(f'baseline (shipped tree)      -> {score}, FAIL: {sorted(baseline) or "none"}')

        uncovered = [row for row in rows if row not in DEFEATS]
        if uncovered:
            problems.append(f'the gate prints rows this harness cannot defeat: {uncovered} — '
                            'add a defeat before the row counts as verified')

        for row in rows:
            if row in baseline:
                print(f'already red, not measurable: {row}')
                continue
            if row not in DEFEATS:
                continue
            root = tmp / f'defeat-{row}'
            stage(root)
            defeat(root, row)
            _, failed, score = run_gate(root)
            expected = baseline | {row}
            print(f'defeated: {row:<5}               -> {score}, FAIL: {sorted(failed) or "none"}')
            if failed != expected:
                if row not in failed:
                    problems.append(f'{row} survived its own defect — the row cannot fail and is not a contract')
                else:
                    extra = sorted(failed - expected)
                    problems.append(f'{row} defeated: also reddened {extra} — the rows are not independent')

    if problems:
        print('\nUNDETECTABLE OR ENTANGLED CONTRACTS:')
        for problem in problems:
            print(f'  - {problem}')
        sys.exit(1)
    measurable = [row for row in rows if row not in baseline]
    print(f'\n{len(measurable)}/{len(rows)} rows are green, and every one of them can be made to fail on its own.')


if __name__ == '__main__':
    main()
