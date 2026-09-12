#!/usr/bin/env python3
"""§1.4 — audit `verify-token-conformance.py` itself, the one gate of eight with no counterfactual.

§1.1 found that `.e1` had silently lost `-webkit-backdrop-filter` for two days while §1 still
read PASS. §1.3 found the *fix* for that had left the gate unable to fail on a dropped
primitive at all. Both were found by reading the gate, not by running it — because a gate that
prints PASS cannot tell you whether it is capable of printing anything else.

Every other gate in this directory now has a harness that defeats it on purpose
(`defeat-composer-conformance.py`, `defeat-short-viewport.mjs`, `verify-prototype.mjs`'s
counterfactual pass). This one did not, which is exactly backwards: it is the gate that has
already gone blind twice.

So: reproduce each defect the gate claims to catch, one at a time, and require **exactly** the
check that owns it to turn FAIL, for **the stated reason**. Three properties are asserted per
mutation, and all three matter:

  1. the gate exits non-zero                    — it noticed
  2. the failing checks equal the expected set  — the right check noticed, and the halves are
                                                  independent (a token defect must not redden
                                                  `primitives`, and vice versa)
  3. the named marker appears in the output     — it noticed *this*, not something else

Property 3 is the one a "did the exit code change?" harness skips, and it is the one that
catches a check reddening for an unrelated reason.

Two further sections cover ground a mutation cannot reach:

  * **allowlist integrity** — `ALLOWED_EXTRA` is the gate's only widening seam, and widening a
    seam to green a gate is how a gate stops being able to fail. Its docstring promises each
    shell metric "names the rule that consumes it"; that promise was prose. It is checked here.
  * **the refusal path** — against an extracted Gate B pin this gate has no `ui/` to read and
    must answer `CANNOT RUN` (exit 2) with no traceback. A traceback in a reviewer's terminal
    reads exactly like a finding against the artifact under review.

`ui/`, `docs/mockups/tokens.css` and the gate itself are never written. Every mutation is
applied to a staged copy in a temporary directory, which is also why the gate needs no
`--root` flag: it derives its paths from `__file__`, so staging the gate beside staged inputs
redirects it without editing it.

    python3 docs/mockups/defeat-token-conformance.py

Exit 0 = every check is individually detectable and the seams hold, 1 = a check cannot fail,
is entangled with another, fails for the wrong reason, or a seam is unenforced, 2 = the
harness could not run (an anchor drifted with the source, so any answer it gave would be about
this file rather than about the gate).
"""

import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
GATE = "docs/mockups/verify-token-conformance.py"
APPROVED = "docs/mockups/tokens.css"
SHIPPED = "ui/src/styles/tokens.css"
STAGED = (GATE, APPROVED, SHIPPED)

# Each mutation restores a defect the gate exists to catch.
#
# `expect` is matched exactly, not as a subset: a token-half defect that also reddens
# `primitives` means the two halves are reading each other's work, which is the entanglement
# §1.3 had to unpick. `marker` is the line the gate must print — the difference between "the
# gate went red" and "the gate went red *about this*".
#
# Anchors are regexes that must match exactly once in the staged file. Two matches is as much
# an anchor failure as none: the second hit is somewhere this harness never looked, and a
# defeat that lands in the wrong place reads exactly like a check that cannot fail.
MUTATIONS = [
    {
        "id": "T1",
        "name": "an approved token is dropped from the shipped file",
        "why": "the plainest form of drift: ADR 0009's \"lifted verbatim\" stops being true",
        "file": SHIPPED,
        "pattern": r"(?m)^[ \t]*--lw-obsidian-950:[ \t]*#08080A;[ \t]*$\n",
        "replacement": "",
        "expect": {"light", "dark"},
        "marker": r"MISSING --lw-obsidian-950",
    },
    {
        "id": "T2",
        "name": "an approved token's value drifts",
        "why": "the token is still there, so a presence check would pass it",
        "file": SHIPPED,
        "pattern": r"(?m)^([ \t]*--lw-obsidian-950:[ \t]*)#08080A;",
        "replacement": r"\1#0A0A0C;",
        "expect": {"light", "dark"},
        "marker": r"DRIFT   --lw-obsidian-950",
    },
    {
        "id": "T3",
        "name": "an undeclared token appears in ui/ and is never reconciled with the design",
        "why": "ALLOWED_EXTRA is a declaration seam; an extra that skips it must fail",
        "file": SHIPPED,
        "pattern": r"(?m)^([ \t]*--lw-obsidian-950:[ \t]*#08080A;[ \t]*)$",
        "replacement": r"\1\n  --lw-bogus-metric: 1px;",
        "expect": {"light", "dark"},
        "marker": r"EXTRA   --lw-bogus-metric",
    },
    {
        "id": "T4",
        "name": "a dark-only token drifts",
        "why": (
            "the per-theme cascade is the point of this gate — a dark regression masked by a "
            "correct light value is the failure mode DESIGN_LANGUAGE §3 opens by naming"
        ),
        "file": SHIPPED,
        "pattern": r"(?m)^([ \t]*--color-ground:[ \t]*)var\(--lw-obsidian-950\);",
        "replacement": r"\1var(--lw-obsidian-900);",
        "expect": {"dark"},
        "marker": r"DRIFT   --color-ground",
    },
    {
        "id": "T5",
        "name": "the approved side is edited instead of the shipped side",
        "why": (
            "the gate must measure a relationship, not lint ui/ — dropping the approved "
            "counterpart has to surface, or the prototype could be quietly rewritten to match"
        ),
        "file": APPROVED,
        "pattern": r"(?m)^[ \t]*--lw-obsidian-950:[ \t]*#08080A;[ \t]*$\n",
        "replacement": "",
        "expect": {"light", "dark"},
        "marker": r"EXTRA   --lw-obsidian-950",
    },
    {
        "id": "P1",
        "name": "§1.1 verbatim — .e1 loses its -webkit-backdrop-filter",
        "why": (
            "this exact line vanished for two days under a PASS, and §1.3's first repair left "
            "the gate unable to see it at all; it is the reason this harness exists"
        ),
        "file": SHIPPED,
        "pattern": r"(?m)^[ \t]*-webkit-backdrop-filter: blur\(20px\);[ \t]*$\n",
        "replacement": "",
        "expect": {"primitives"},
        "marker": r"UNDECLARED -  -webkit-backdrop-filter: blur\(20px\);",
    },
    {
        "id": "P2",
        "name": "a primitive's value changes",
        "why": "primitives carry no token name, so the drift check above can never see them",
        "file": SHIPPED,
        "pattern": r"(?m)^([ \t]*backdrop-filter: )blur\(20px\);",
        "replacement": r"\1blur(12px);",
        "expect": {"primitives"},
        "marker": r"UNDECLARED \+  backdrop-filter: blur\(12px\);",
    },
    {
        "id": "P3",
        "name": "an unreviewed primitive rule is added",
        "why": "every surface inherits these; an addition is as unreviewed as a change",
        "file": SHIPPED,
        "pattern": r"(?m)^\.e1 \{$",
        "replacement": ".lw-bogus-primitive { outline: 3px dashed red; }\n.e1 {",
        "expect": {"primitives"},
        "marker": r"UNDECLARED \+\.lw-bogus-primitive \{ outline: 3px dashed red; \}",
    },
]


def cannot_run(message):
    print(f"CANNOT RUN — {message}")
    sys.exit(2)


def stage(root):
    """Copy the gate and both its inputs into `root`, preserving repo-relative layout."""
    for rel in STAGED:
        source = REPO / rel
        if not source.exists():
            cannot_run(f"a staged input is missing from the repo: {rel}")
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def apply_mutation(root, mutation):
    path = root / mutation["file"]
    text = path.read_text()
    hits = len(re.findall(mutation["pattern"], text))
    if hits != 1:
        cannot_run(
            f"{mutation['id']}: the anchor matched {hits} times (expected 1) in "
            f"{mutation['file']}:\n    {mutation['pattern']}\n"
            "    The source moved under this harness. Re-anchor it before trusting any\n"
            "    result — a mutation that does not apply reads exactly like a check that\n"
            "    cannot fail."
        )
    path.write_text(re.sub(mutation["pattern"], mutation["replacement"], text, count=1))


def run_gate(root):
    result = subprocess.run(
        [sys.executable, str(root / GATE)], capture_output=True, text=True
    )
    if result.stderr.strip():
        cannot_run(
            f"the gate wrote to stderr, which it should never do:\n{result.stderr.strip()}"
        )
    failed = set(re.findall(r"(?m)^FAIL (light|dark|primitives)\b", result.stdout))
    seen = set(re.findall(r"(?m)^(?:PASS|FAIL) (light|dark|primitives)\b", result.stdout))
    if seen != {"light", "dark", "primitives"}:
        cannot_run(
            f"the gate printed checks {sorted(seen)}, expected light/dark/primitives — "
            "its output shape changed and this harness can no longer read it"
        )
    return result.returncode, failed, result.stdout


def check_allowlist(problems):
    """`ALLOWED_EXTRA` is the only seam that can widen this gate. Hold it to its own promise."""
    source = (REPO / GATE).read_text()
    block = re.search(r"ALLOWED_EXTRA = \{(.*?)\n\}", source, re.S)
    if not block:
        cannot_run("ALLOWED_EXTRA could not be located in the gate")
    allowed = re.findall(r'"(--[\w-]+)"', block.group(1))
    shipped = (REPO / SHIPPED).read_text()
    consumers = "\n".join(
        path.read_text() for path in sorted((REPO / "ui/src").rglob("*.css"))
    )

    print(f"\nallowlist integrity — {len(allowed)} declared extra(s)")
    for name in allowed:
        declared = re.search(rf"(?m)^[ \t]*{re.escape(name)}[ \t]*:", shipped) is not None
        # Tailwind's `@theme` palette plumbing is consumed by generated utilities
        # (`bg-black`, `text-transparent`), never through `var()`. Only the app-shell
        # metrics carry the gate's "names the rule that consumes it" promise.
        shell = name.startswith("--lw-")
        consumed = f"var({name}" in consumers if shell else None
        print(
            f"  {name:<22} declared={'yes' if declared else 'NO '} "
            f"consumed={'n/a' if consumed is None else ('yes' if consumed else 'NO')}"
        )
        if not declared:
            problems.append(
                f"ALLOWED_EXTRA names {name}, which ui/ does not declare — a dead entry "
                "suppresses nothing today and silently pre-authorises that token's return"
            )
        if consumed is False:
            problems.append(
                f"ALLOWED_EXTRA names {name}, and no rule under ui/src consumes it — the "
                "gate's own docstring says such an entry was added to silence the gate "
                "rather than to describe the app"
            )


def check_refusal(problems, tmp):
    """Against an extracted Gate B pin there is no `ui/`. The answer must be "cannot", not a crash."""
    print("\nrefusal path — the gate run against a docs/-only pin")
    for label, rel in (("shipped", SHIPPED), ("approved", APPROVED)):
        root = tmp / f"absent-{label}"
        stage(root)
        (root / rel).unlink()
        result = subprocess.run(
            [sys.executable, str(root / GATE)], capture_output=True, text=True
        )
        ok = result.returncode == 2 and "CANNOT RUN" in result.stdout
        clean = not result.stderr.strip()
        print(
            f"  {label + ' input absent':<24} exit={result.returncode} "
            f"says-cannot-run={'yes' if 'CANNOT RUN' in result.stdout else 'NO'} "
            f"traceback={'NO' if clean else 'YES'}"
        )
        if not ok:
            problems.append(
                f"with the {label} input absent the gate exited {result.returncode} instead "
                "of 2 with CANNOT RUN — a reviewer cannot tell a missing input from a defect"
            )
        if not clean:
            # Indented so the traceback stays inside its bullet — an unindented one reads as
            # this harness crashing, which is the same confusion the refusal path exists to end.
            raised = "\n".join(f"      {line}" for line in result.stderr.strip().split("\n"))
            problems.append(
                f"with the {label} input absent the gate raised:\n{raised}"
            )


def main():
    problems = []
    with tempfile.TemporaryDirectory(prefix="loomwatch-token-defeat-") as tmp:
        tmp = pathlib.Path(tmp)

        base = tmp / "baseline"
        stage(base)
        code, baseline, _ = run_gate(base)
        print(f"baseline (shipped tree)  -> exit {code}, FAIL: {sorted(baseline) or 'none'}")
        if code != 0 or baseline:
            cannot_run(
                "the baseline is already red. This harness asks whether a green gate is "
                "capable of\n    going red; against a red baseline that question has no "
                "answer. Fix the defect the\n    gate is reporting, then re-run."
            )

        for mutation in MUTATIONS:
            root = tmp / f"defeat-{mutation['id']}"
            stage(root)
            apply_mutation(root, mutation)
            code, failed, output = run_gate(root)
            marker = re.search(mutation["marker"], output) is not None
            print(
                f"{mutation['id']} {mutation['name'][:58]:<58} -> exit {code}, "
                f"FAIL: {sorted(failed) or 'none'}, marker={'yes' if marker else 'NO'}"
            )
            if code == 0:
                problems.append(
                    f"{mutation['id']} survived: {mutation['name']} — the gate stayed green. "
                    f"{mutation['why']}."
                )
                continue
            if failed != mutation["expect"]:
                missed = sorted(mutation["expect"] - failed)
                spilled = sorted(failed - mutation["expect"])
                if missed:
                    problems.append(
                        f"{mutation['id']}: {sorted(mutation['expect'])} own this defect but "
                        f"{missed} stayed green — the gate went red for another reason"
                    )
                if spilled:
                    problems.append(
                        f"{mutation['id']}: also reddened {spilled} — the checks are "
                        "entangled and one is scoring the other's work"
                    )
            if not marker:
                problems.append(
                    f"{mutation['id']}: the gate went red but never printed "
                    f"`{mutation['marker']}` — it noticed something, not this"
                )

        check_allowlist(problems)
        check_refusal(problems, tmp)

    if problems:
        print("\nTHE GATE CANNOT BE TRUSTED TO FAIL:")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print(
        f"\n{len(MUTATIONS)}/{len(MUTATIONS)} defects detected by exactly the check that owns "
        "them, for the stated reason;\nthe allowlist declares nothing dead or unconsumed, and "
        "the refusal path answers without a traceback."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
