#!/usr/bin/env python3
"""TNG-90 §7.1 — mutation audit of verify-evidence-honesty.mjs.

A gate that has never failed is not evidence. Gate B card 0e52ed0c cites this
probe's 5/5 as the proof B1 closed, and `4ddd2d0` has already found one check in
a sibling gate (D5, §3.4 `[ Reuse ]`) that could not fail on the defect it named.
That defect survived the comment-stripping sweep run there, because its bare word
also matched a live identifier — so comment-stripping is only half the class.

This defeats each contract one at a time, in a scratch copy of the five inputs,
and asserts that the check which OWNS that contract turns FAIL. A mutation that
leaves the gate green is a check that cannot fail; a mutation that exits 2 means
the probe lost its anchor rather than observing the defect, which is honest but
is not detection either.

  python3 docs/mockups/mutate-evidence-honesty.py [--keep]

Exit 0 = every contract is detectable by its owning check. Exit 1 = at least one
check cannot fail. Exit 2 = the harness could not run (absent input, baseline not
green), never a verdict about the contracts.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATE = 'docs/mockups/verify-evidence-honesty.mjs'
INPUTS = [
    GATE,
    'ui/src/lib/watch/events.ts',
    'ui/src/components/run/ProvenancePanel.tsx',
    'ui/src/components/run/RunColumn.tsx',
    'ui/src/components/run/StoryNodes.tsx',
    'ui/src/components/run/coverage.ts',
]

EVENTS = 'ui/src/lib/watch/events.ts'
PANEL = 'ui/src/components/run/ProvenancePanel.tsx'


def sub(path: str, old: str, new: str):
    """One exact, unique replacement — a mutation that silently no-ops would fake a pass."""
    def apply(tree: Path):
        target = tree / path
        text = target.read_text()
        if text.count(old) != 1:
            raise SystemExit(f'MUTATION DID NOT APPLY: {old[:60]!r} occurs {text.count(old)}x in {path}')
        target.write_text(text.replace(old, new))
    return apply


# Each mutation reintroduces a defect the probe's own detail text claims to catch.
MUTATIONS = [
    dict(
        id='M1', owner='B1',
        what='`capture` is dropped from `interface Evidence` (the pre-TNG-170 shape: §8.1 unrepresentable)',
        mutate=sub(EVENTS,
                   "  /** §8.1 epistemic quality. Set only by the projector (see the invariant in `projectRun`). */\n  capture: Capture\n",
                   ""),
    ),
    dict(
        id='M2', owner='B1',
        what="`Capture` stops admitting `'redacted'` — a §8.1 state the type can no longer name",
        mutate=sub(EVENTS,
                   "export type Capture = 'recorded' | 'derived' | 'redacted' | 'unavailable'",
                   "export type Capture = 'recorded' | 'derived' | 'unavailable'"),
    ),
    dict(
        id='M3', owner='B2',
        what='the panel entity row asserts the capture word locally as a literal (exactly the B1 defect)',
        mutate=sub(PANEL,
                   '`${item.kind}: ${item.name}, ${item.capture}`',
                   '`${item.kind}: ${item.name}, recorded`'),
    ),
    dict(
        id='M4', owner='B3',
        what='the panel stops reading the published level and derives its own — but a COMMENT still says coverageFor(',
        mutate=sub(PANEL,
                   "        const level = coverageFor(category.key, projection)",
                   "        // was: const level = coverageFor(category.key, projection)\n        const level = items.length > 0 ? 'complete' : 'unavailable'"),
    ),
    dict(
        id='M5', owner='B4',
        what='the agents row goes back to the headcount — no terminal evidence consulted',
        mutate=sub(EVENTS,
                   "        : spawned.length > 0 && spawned.every((agent) => agent.exitCode !== null || ['succeeded', 'failed', 'stopped'].includes(agent.status))",
                   "        : list.length > 0"),
    ),
    dict(
        id='M6', owner='B5',
        what='the tools row stops consulting unpaired calls — tools reads `complete` with calls still open',
        mutate=sub(EVENTS,
                   "          : unpairedCalls > 0\n            ? { level: 'partial', reason: 'unpaired_calls', observed: observed.tools }\n            : { ...settled, observed: observed.tools }),",
                   "          : { ...settled, observed: observed.tools }),"),
    ),
    # M7-M9 are the evasions the strengthened B3/B5 must also catch: each keeps the token the
    # weaker check watched for, and breaks the contract anyway.
    dict(
        id='M7', owner='B5',
        what='`unpairedCalls` becomes a standing zero — the branch survives, the fact behind it does not',
        mutate=sub(EVENTS,
                   "  const unpairedCalls = list.reduce((sum, agent) => sum + agent.openCalls.size, 0)\n"
                   "    + evidence.filter((item) => item.kind === 'permission' && (item.status === 'pending' || item.status === 'running')).length",
                   "  const unpairedCalls = 0"),
    ),
    dict(
        id='M8', owner='B5',
        what='the count is discarded at the projection boundary again (the original B5 defect shape)',
        mutate=sub(EVENTS,
                   "handedOff: _h, openCalls, ...agent }) => ({ ...agent, openCalls: openCalls.size })),",
                   "handedOff: _h, openCalls: _o, ...agent }) => ({ ...agent })),"),
    ),
    dict(
        id='M9', owner='B3',
        what='the panel keeps the §4.1 summary chip honest but invents every per-category level from a count',
        mutate=sub(PANEL,
                   "        const level = coverageFor(category.key, projection)",
                   "        const level = items.length > 0 ? 'complete' : 'unavailable'"),
    ),
]


def build(tmp: Path) -> Path:
    tree = tmp / 'tree'
    for rel in INPUTS:
        src = ROOT / rel
        if not src.exists():
            print(f'CANNOT RUN — absent input: {rel}\n'
                  'This harness mutates the shipped `ui/` tree, so it only answers from a full\n'
                  'repo checkout. It is not a statement about any pinned artifact.', file=sys.stderr)
            raise SystemExit(2)
        dst = tree / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    return tree


def run_gate(tree: Path):
    proc = subprocess.run(['node', str(tree / GATE)], capture_output=True, text=True)
    failed = {line.split()[1] for line in proc.stdout.splitlines() if line.startswith('FAIL')}
    return proc.returncode, failed, proc.stdout + proc.stderr


def main() -> int:
    keep = '--keep' in sys.argv
    tmp = Path(tempfile.mkdtemp(prefix='mutate-evidence-', dir=os.environ.get('PAPERCLIP_RUN_SCRATCH_DIR') or None))
    try:
        code, failed, out = run_gate(build(tmp))
        if code != 0 or failed:
            print('CANNOT RUN — the baseline copy is not green, so no mutation result would mean anything:\n' + out, file=sys.stderr)
            return 2
        print('baseline  5/5, exit 0 — the scratch copy reproduces the shipped gate\n')

        undetected = []
        for m in MUTATIONS:
            tree = build(tmp)
            m['mutate'](tree)
            code, failed, out = run_gate(tree)
            owner = m['owner']
            if code == 2:
                verdict, ok = 'LOST ANCHOR (exit 2 — honest, but not detection)', False
            elif owner in failed:
                verdict, ok = f'detected by {owner} (exit {code})', True
            elif failed:
                verdict, ok = f'{owner} still PASSED; only {sorted(failed)} failed', False
            else:
                verdict, ok = 'NOT DETECTED — gate stayed 5/5, exit 0', False
            print(f"{'ok  ' if ok else 'GAP '} {m['id']} ({owner}): {m['what']}\n       -> {verdict}")
            if not ok:
                undetected.append((m, out))

        print()
        if undetected:
            print(f'{len(undetected)}/{len(MUTATIONS)} contracts are NOT detectable by the check that owns them.')
            for m, out in undetected:
                print(f"\n--- {m['id']} ({m['owner']}) gate output under the defect ---\n{out.rstrip()}")
            return 1
        print(f'{len(MUTATIONS)}/{len(MUTATIONS)} contracts detectable — every check can fail on the defect it names.')
        return 0
    finally:
        if keep:
            print(f'\nscratch kept: {tmp}')
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
