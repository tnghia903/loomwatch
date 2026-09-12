#!/usr/bin/env python3
"""Verify that ui/src/styles/tokens.css carries the approved docs/mockups/tokens.css values.

ADR 0009 claims the design tokens were "lifted verbatim" from the prototype. This checks
that claim per theme rather than per file, because the shipped file restructures where
light lives: the prototype's `[data-theme="light"]` block became Tailwind's `@theme`.

A token is conformant when the value an author would resolve in a given theme is
byte-identical (whitespace-normalised) to the approved one. Exits non-zero on any missing
token, any value drift, and any extra not named in `ALLOWED_EXTRA` below — the app does
legitimately add shell metrics and Tailwind plumbing a static prototype has no need for,
but each one is declared here with the rule that consumes it, so a token invented in `ui/`
and never reconciled with the design is a failure rather than a line of noise.

    python3 docs/mockups/verify-token-conformance.py

Run it from a full repo checkout. This gate measures the *implementation*, so one of its two
inputs lives in `ui/` and is outside the `docs/` tree a Gate B pin extracts. Run against an
extracted pin it cannot answer, and it says so (exit 2) rather than raising — an unreadable
stack trace in a reviewer's terminal is indistinguishable from a real drift failure.
"""

import collections
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
APPROVED = ROOT / "docs/mockups/tokens.css"
SHIPPED = ROOT / "ui/src/styles/tokens.css"

# Not design tokens: Tailwind's `@theme` palette plumbing and app-shell layout metrics.
# Each shell metric names the rule that consumes it, so an entry added to silence the gate
# rather than to describe the app is visible as an entry whose consumer cannot be found.
ALLOWED_EXTRA = {
    "--color-black",
    "--color-white",
    "--color-transparent",
    "--lw-bottom-offset",
    "--lw-composer-w",
    # `.lw-schedule-panel` width (app.css) — the run-schedule panel has no prototype counterpart.
    "--lw-schedule-w",
    # The zoom bar never moves, so every right-docked panel stops above it: `.lw-activity`
    # (runtime.css) and the right panel max-height (app.css). A static prototype, which has
    # no scrolling panel to clear, has no counterpart.
    "--lw-viewctl-clear",
}


def blocks(path):
    """Map each top-level selector to the custom properties it declares."""
    src = re.sub(r"/\*.*?\*/", "", path.read_text(), flags=re.S)
    out = collections.OrderedDict()
    for match in re.finditer(r"(?m)^([^\s@][^{\n]*|@theme[^{\n]*)\{(.*?)^\}", src, flags=re.S):
        declared = re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", match.group(2))
        if declared:
            out.setdefault(match.group(1).strip(), {}).update(
                {name: " ".join(value.split()) for name, value in declared}
            )
    return out


def cascade(parsed, theme, base_selectors):
    """Resolve the value an author sees in `theme`, applying blocks in source order."""
    resolved = {}
    for selector, tokens in parsed.items():
        if selector in base_selectors or selector.startswith("@theme"):
            resolved.update(tokens)
    for selector, tokens in parsed.items():
        if theme in selector:
            resolved.update(tokens)
    return resolved


def primitives(path):
    """The non-token remainder: type ramps, elevation, focus ring, media queries."""
    src = re.sub(r"/\*.*?\*/", "", path.read_text(), flags=re.S)
    src = re.sub(r"(?m)^\s*--[\w-]+\s*:[^;]+;\s*$\n?", "", src)
    return [line.rstrip() for line in src.split("\n") if line.strip()]


def check_primitives():
    import difflib

    delta = list(
        difflib.unified_diff(
            primitives(APPROVED), primitives(SHIPPED), "approved", "shipped", lineterm="", n=1
        )
    )
    body = [line for line in delta if line[:1] in "+-" and line[1:2] not in "+-"]
    print(f"\nNon-token primitives: {len(body)} differing line(s)")
    for line in delta:
        print("   ", line)
    return body


def check_inputs():
    """Refuse legibly when an input is absent, naming which side is missing and why.

    The Gate B card lists this gate in a table headed "re-run against the pinned bytes."
    It is the one row that cannot be: `SHIPPED` is production source, outside the `docs/`
    tree `git archive <pin> docs` extracts. A reviewer working down that table from an
    extracted pin used to get a `FileNotFoundError` traceback here, which reads exactly
    like the gate finding something wrong with the artifact under review. It isn't — the
    gate simply has nothing to measure there.
    """
    for label, path, why in (
        ("approved", APPROVED, "the prototype tokens this gate measures against"),
        ("shipped", SHIPPED, "production source, NOT part of a pinned `docs/` artifact"),
    ):
        if not path.exists():
            print(f"CANNOT RUN — the {label} input is missing:\n    {path}\n    ({why})")
            print(
                "\nThis gate compares the shipped implementation against the approved "
                "prototype tokens,\nso it needs both sides and only answers from a full repo "
                "checkout. It is not a\nstatement about the pinned artifact, and this is not "
                "a drift failure."
            )
            return False
    return True


def main():
    if not check_inputs():
        return 2

    approved, shipped = blocks(APPROVED), blocks(SHIPPED)
    failed = False

    for theme in ("light", "dark"):
        want = cascade(approved, theme, {":root"})
        # The shipped file has no `[data-theme="light"]`; light is `:root` + `@theme`.
        got = cascade(shipped, theme, {":root"})

        missing = sorted(name for name in want if name not in got)
        drift = sorted((n, want[n], got[n]) for n in want if n in got and want[n] != got[n])
        extra = sorted(set(got) - set(want) - ALLOWED_EXTRA)

        status = "FAIL" if (missing or drift or extra) else "PASS"
        print(
            f"{status} {theme:<5} approved={len(want)} shipped={len(got)} "
            f"missing={len(missing)} drift={len(drift)} unexpected-extra={len(extra)}"
        )
        for name in missing:
            print(f"    MISSING {name} (approved: {want[name]})")
        for name, expected, actual in drift:
            print(f"    DRIFT   {name}\n              approved: {expected}\n              shipped : {actual}")
        for name in extra:
            print(f"    EXTRA   {name}: {got[name]}")
        failed |= bool(missing or drift or extra)

    print("\nToken conformance:", "FAILED" if failed else "clean — every approved token matches")

    # Reported, never failed: the restructure below is what the approved file's own header
    # tells an implementer to do ("swap the @theme { } wrapper back in for the light tier-2
    # block"), so a diff here is expected and must be read, not gated.
    check_primitives()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
