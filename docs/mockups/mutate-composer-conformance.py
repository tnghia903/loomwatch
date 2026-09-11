#!/usr/bin/env python3
"""§10.5 — audit verify-composer-conformance.mjs itself.

A check that has never failed is not evidence, and a check that has never *passed*
is not a contract — it may simply be unsatisfiable, or anchored to something that
can never appear. This harness proves both directions for all thirteen rows:

  1. Apply all eight fixes to a scratch copy → the gate must read 13/13.
  2. Revert one fix at a time → exactly the owning row must turn FAIL.
  3. Break one of the five rows that pass today → exactly that row must turn FAIL.

`ui/` is never written. Everything happens in a scratch copy of the five inputs.

  python3 docs/mockups/mutate-composer-conformance.py

Exit 0 = every contract is detectable in both directions, 1 = a row cannot fail or
cannot pass, 2 = the harness could not run (a patch anchor drifted with the source).
"""
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
GATE = REPO / 'docs/mockups/verify-composer-conformance.mjs'
INPUTS = [
    'ui/src/components/composer/Composer.tsx',
    'ui/src/components/Workspace.tsx',
    'ui/src/styles/runtime.css',
    'ui/src/lib/runs/client.ts',
    'ui/src/lib/team-file/client.ts',
]
OPEN_ROWS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C9']
GREEN_ROWS = ['C8', 'C10', 'C11', 'C12', 'C13']


def fail_harness(message):
    print(f'CANNOT RUN — {message}')
    sys.exit(2)


def stage(root):
    for rel in INPUTS:
        source = REPO / rel
        if not source.exists():
            fail_harness(f'the shipped input is missing: {rel}')
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(source, target)


def sub(root, rel, old, new, label):
    path = root / rel
    text = path.read_text()
    if old not in text:
        fail_harness(f'patch anchor lost ({label}) in {rel}: {old[:60]!r}')
    path.write_text(text.replace(old, new, 1))


TERMINALS = (
    "    if (doc.mode === 'pipeline' && terminals !== 1) return { kind: 'blocked', "
    "reason: `A pipeline needs exactly one final agent — ${terminals} found.`, "
    "action: { label: 'Show on canvas', run: () => void flow.fitView({ padding: 0.2, duration: 300 }) } }"
)


def apply_fixes(root, skip=()):
    """The eight fixes that close the open rows. `skip` leaves one row unfixed."""
    W, C = 'ui/src/components/Workspace.tsx', 'ui/src/components/composer/Composer.tsx'
    CSS, RUNS = 'ui/src/styles/runtime.css', 'ui/src/lib/runs/client.ts'

    if 'C1' not in skip:
        sub(root, W, "      if (event.key === 'F8') {",
            "      if (mod && event.key === 'Enter') { event.preventDefault(); void submit(); return }\n"
            "      if (event.key === 'F8') {", 'C1')

    if 'C2' not in skip:
        sub(root, C, "    element.style.height = `${Math.min(120, element.scrollHeight)}px`\n  }, [value])",
            "    element.style.height = focused ? `${Math.min(100, element.scrollHeight)}px` : ''\n"
            "  }, [value, focused])", 'C2')

    if 'C3' not in skip:
        sub(root, CSS, 'max-height: 120px;', 'max-height: 100px;', 'C3 css')
        if 'C2' in skip:  # C2's edit already rewrote the clamp; only touch it when it did not.
            sub(root, C, 'Math.min(120,', 'Math.min(100,', 'C3 js')

    if 'C4' not in skip or 'C5' not in skip:
        reason = ("`A pipeline run needs exactly one final agent. This one has ${terminals}: "
                  "${terminalIds.map((id) => nodeNames.get(id) ?? id).join(', ')}.`"
                  if 'C4' not in skip else
                  '`A pipeline needs exactly one final agent — ${terminals} found.`')
        action = ("run: () => { doc.onNodesChange(doc.nodes.map((node) => ({ id: node.id, "
                  "type: 'select' as const, selected: terminalIds.includes(node.id) }))); "
                  "void flow.fitView({ padding: 0.2, duration: 300 }) }"
                  if 'C5' not in skip else
                  'run: () => void flow.fitView({ padding: 0.2, duration: 300 })')
        sub(root, W, TERMINALS,
            "    if (doc.mode === 'pipeline' && terminals !== 1) return { kind: 'blocked', reason: "
            + reason + ", action: { label: 'Show on canvas', " + action + " } }", 'C4/C5')

    if 'C6' not in skip:
        sub(root, C, "  | { kind: 'saving'; filename: string }",
            "  | { kind: 'saving'; filename: string }\n  | { kind: 'starting' }", 'C6 union')
        sub(root, W, "    if (starting || pendingPrompt !== null) return { kind: 'saving', filename }",
            "    if (pendingPrompt !== null) return { kind: 'saving', filename }\n"
            "    if (starting) return { kind: 'starting' }", 'C6 branch')

    if 'C7' not in skip or 'C9' not in skip:
        body = 'JSON.stringify({ teamPath, prompt'
        signature = 'export async function startRun(teamPath: string, prompt: string'
        extra = ''
        if 'C7' not in skip:
            body += ', startKey'
            extra += ', startKey: string'
        if 'C9' not in skip:
            body += ', expectedRevision'
            extra += ', expectedRevision: string | null'
        sub(root, RUNS, 'JSON.stringify({ teamPath, prompt })', body + ' })', 'C7/C9 body')
        sub(root, RUNS, signature, signature + extra, 'C7/C9 signature')


def break_green(root, row):
    """Defeat one of the rows that passes today, without touching the others."""
    W, C = 'ui/src/components/Workspace.tsx', 'ui/src/components/composer/Composer.tsx'
    if row == 'C8':
        sub(root, 'ui/src/lib/team-file/client.ts', "'If-Match'", "'X-Match'", row)
    elif row == 'C10':
        sub(root, 'ui/src/styles/runtime.css',
            '@media (max-width: 767px) {\n  .lw-composer { width:',
            '@media (max-width: 767px) {\n  .lw-composer { display: none; width:', row)
    elif row == 'C11':
        sub(root, C, '<div className="comp-mid">',
            '<div className="comp-mid"><input type="range" aria-label="temperature" />', row)
    elif row == 'C12':
        sub(root, W,
            "      if (!saved) { setStartError('The team file could not be saved, so no run was started.'); return }",
            "      if (!saved) setStartError('could not save')", row)
    elif row == 'C13':
        sub(root, W, '    const parent = activeRunId', "    setComposerText('')\n    const parent = activeRunId", row)


def run_gate(root):
    result = subprocess.run(['node', str(GATE)], capture_output=True, text=True,
                            env={**__import__('os').environ, 'LOOMWATCH_ROOT': str(root)})
    if result.returncode == 2:
        fail_harness(f'the gate could not answer:\n{result.stderr.strip()}')
    failed = set(re.findall(r'^FAIL\s+(C\d+)', result.stdout, re.M))
    total = re.search(r'(\d+)/(\d+) contracts met', result.stdout)
    if not total:
        fail_harness('the gate printed no score line')
    return failed, f'{total.group(1)}/{total.group(2)}'


def main():
    if not GATE.exists():
        fail_harness(f'the gate is missing: {GATE}')
    problems = []
    with tempfile.TemporaryDirectory(prefix='loomwatch-composer-mutate-') as tmp:
        tmp = pathlib.Path(tmp)

        # 1. every open row CAN pass.
        allfix = tmp / 'all'
        stage(allfix)
        apply_fixes(allfix)
        failed, score = run_gate(allfix)
        print(f'all eight fixes applied      -> {score}, FAIL: {sorted(failed) or "none"}')
        if failed:
            problems.append(f'rows still failing with every fix applied: {sorted(failed)} — '
                            'these cannot be satisfied and are not contracts')

        # 2. each open row fails on its own, and takes nothing else with it.
        for row in OPEN_ROWS:
            root = tmp / f'skip-{row}'
            stage(root)
            apply_fixes(root, skip=(row,))
            failed, score = run_gate(root)
            print(f'fix reverted: {row:<3}            -> {score}, FAIL: {sorted(failed) or "none"}')
            if failed != {row}:
                problems.append(f'{row} reverted: expected exactly {{{row}}} to fail, got {sorted(failed)}')

        # 3. each row green today can go red.
        for row in GREEN_ROWS:
            root = tmp / f'break-{row}'
            stage(root)
            apply_fixes(root)
            break_green(root, row)
            failed, score = run_gate(root)
            print(f'defeated (passes today): {row:<3} -> {score}, FAIL: {sorted(failed) or "none"}')
            if failed != {row}:
                problems.append(f'{row} defeated: expected exactly {{{row}}} to fail, got {sorted(failed)}')

    if problems:
        print('\nUNDETECTABLE CONTRACTS:')
        for problem in problems:
            print(f'  - {problem}')
        sys.exit(1)
    print('\n13/13 contracts are detectable in both directions.')


if __name__ == '__main__':
    main()
