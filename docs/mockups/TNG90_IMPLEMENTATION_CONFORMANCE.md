# TNG-90 — design conformance of the shipped workspace against the approved design

- **Date:** 2026-09-11
- **Checked by:** Product/UX Designer
- **Approved baseline:** TNG-87 design (`docs/DESIGN_LANGUAGE.md`, `docs/UX_REDESIGN.md`),
  TNG-89A interaction spec (`docs/TNG89_INTERACTION.md`), prototype tokens
  (`docs/mockups/tokens.css`)
- **Subject:** the prompt-to-output workspace described by
  `docs/decisions/0009-prompt-to-output-workspace-shipped.md` (uncommitted working tree)
- **Verdict:** **conformant** on the design-system layer. One documentation gap (§4 below).

This checks the implementation's *claims* against the approved design. It does not review
code quality, and it does not touch the Gate B artifact — see §5.

## 1. Design tokens — PASS, zero drift

ADR 0009 claims tokens were "lifted verbatim" from `docs/mockups/tokens.css`. Checked by
parsing both files into `name → value` maps per theme tier and diffing.

Approved blocks: `:root` (83) + `[data-theme="light"]` (24) + `[data-theme="dark"]` (24).
Shipped blocks: `:root` (86) + `@theme` (26) + `[data-theme="dark"]` (24). Light moved from
a `[data-theme="light"]` block into Tailwind's `@theme`, per ADR 0009 decision 4.

| Theme | Approved tokens | Missing | Value drift | Extra |
|---|---|---|---|---|
| Light | 107 | **0** | **0** | 5 |
| Dark | 107 | **0** | **0** | 5 |

Every one of the 107 approved tokens resolves to a byte-identical value in both themes. The
5 extras are not design tokens: `--color-black`, `--color-white`, `--color-transparent` are
Tailwind's `@theme` plumbing (with `--color-*: initial` clearing its defaults), and
`--lw-bottom-offset` / `--lw-composer-w` are app-shell layout metrics with no counterpart in
a static prototype.

The claim holds exactly.

## 2. Typography, elevation and focus primitives — PASS

The non-token remainder of the two files (all ten `.t-*` type ramps, `.tnum`, `.e1`/`.e2`
elevation, the focus-visible ring, the reduced-motion query) differs by **9 lines**, in
three places — all three intended:

1. The light selector changed from `:root, [data-theme="light"]` to `@theme` +
   `:root` (ADR 0009 decision 4). This is not an implementer's liberty: the approved
   `tokens.css` header *instructs* it — *"written to be liftable almost verbatim into
   `ui/src/index.css`: swap the `@theme { }` wrapper back in for the light tier-2 block."*
2. Focus-visible **widened** from `button, [role="button"], a, input, [tabindex]` to also
   include `textarea, select`. This is a correction in the spirit of §6.1, not drift — the
   composer is a `textarea` and would otherwise have taken no visible focus ring.
3. `[data-motion="reduce"] { --bloom: none; }` is dropped. Correct — see §3.

Everything else, including all ten type ramps, matches byte for byte.

## 3. Reduced motion — PASS

Worth recording because a reduced-motion defect is what caused the first Gate B card
(pinned to `be2ca55`) to be withdrawn.

The prototype's `[data-motion="reduce"]` mechanism is **correctly absent** from production.
That attribute exists only to serve `prototype.html`'s reviewer control
(`<button id="motionBtn" title="Simulate prefers-reduced-motion">`) — a simulator so a
reviewer can preview the reduced state without changing an OS setting. Production has no
business shipping a simulator; it implements the real query.

Every prototype reduced-motion rule has a production counterpart:

| Approved `[data-motion="reduce"]` rule | Shipped `@media (prefers-reduced-motion: reduce)` |
|---|---|
| `*, *::before, *::after` animation/transition kill | `app.css` — same wildcard |
| `.weft { animation: none }` | `app.css` — `.react-flow__edge-path.weft` |
| `.shuttle { display: none }` | `app.css` — `.react-flow__edge-path.shuttle` |
| `.node.has-task.st-running/.st-starting` static 2 px border | `app.css` — same, same border |
| `.status-arc`, `.status-halo` | covered by the wildcard (`animation-iteration-count: 1`) |
| — | `runtime.css` adds `.prov-live`, `.rr-stream`, `.caret` |

All ten infinite animations in the shipped stylesheets are reached by either a targeted rule
or the wildcard. `runtime.css` covers three surfaces the prototype did not have.

## 4. Trace vocabulary — PASS, with a spec gap to close

**The approved vocabulary is fully implemented.** `ui/src/components/ui/glyphs.tsx`
`EntityKind` carries all eight §4.2 kinds — `prompt`, `response`, `agent`, `reasoning`,
`skill`, `tool`, `command`, `source` — each with a glyph.

**The six grouped summaries of §4.1 are exact.** `ProvenancePanel.tsx` fixes the order as
`agents, reasoning, skills, tools, commands, sources`, matching the spec and `CONTRACT §12`.
The fixed-order requirement ("a graph that reorders itself by count is unlearnable") is met.

**The chain-of-thought constraint is honoured as written.** §4.2 says `reasoning` is
`thought` and `plan` only, and that the UI must never synthesise a reasoning node from prose.
Production groups `plan` evidence under `reasoning`, counts `thought` events separately, and
states in the empty case: *"No thought or plan events were recorded. Hidden chain-of-thought
is never requested."* Nothing is inferred from an answer's prose.

**The gap.** Production classifies evidence at a finer grain than §4.2 describes.
`EvidenceKind` has nine values; five of them — `file`, `search`, `delegation`, `permission`,
`plan` — have no row in the §4.2 table, so they have a glyph in code but no approved size,
primary line or secondary line contract.

These are **not a competing taxonomy**. Each rolls up into an approved category:

| Production sub-kind | Rolls up into (§4.1 category) |
|---|---|
| `plan` | `reasoning` |
| `delegation`, `permission` | `tools` |
| `file`, `search` | `sources` |

The finer grain is derived from what the archive actually contains (ACP `toolKind`, Team Bus
pairs) rather than invented, which is the honest direction. The defect is in the **spec**,
not the build: §4.2 under-describes what production renders. §4.2 should absorb the five
sub-kinds with their sizes and line contracts, and state the rollup explicitly.

Tracked separately so it does not churn the pending Gate B artifact — see §5.

## 5. What this does not touch

The Gate B confirmation card pinned to commit `83b4a49` is **unaffected and still valid**.
`docs/mockups/prototype-standalone.html` on disk hashes
`9b3391a603f8d81469d57beff9e83e96f0a31428346d7ab70166d603ba34e6e1`, byte-identical to the
same path at `83b4a49`. The gap in §4 is between the spec and an implementation the card
does not cover; amending §4.2 now would invalidate a pinned artifact to fix a documentation
gap, which is the wrong trade while the card is pending.

## How to reproduce

```sh
# §1 and §2 — per-theme token diff, then the non-token primitives diff.
# Exits non-zero on any missing token, value drift, or unexpected extra.
python3 docs/mockups/verify-token-conformance.py

# §3 — reduced-motion coverage
grep -rn 'infinite' ui/src/styles/*.css
for f in ui/src/styles/*.css; do awk '/prefers-reduced-motion/,/^\}/' "$f"; done

# §4 — vocabulary
grep -n 'EntityKind =' ui/src/components/ui/glyphs.tsx
grep -n 'EvidenceKind =' ui/src/lib/watch/events.ts
sed -n '9,16p' ui/src/components/run/ProvenancePanel.tsx

# §5 — artifact still matches the pinned commit
shasum -a 256 docs/mockups/prototype-standalone.html
git show 83b4a49:docs/mockups/prototype-standalone.html | shasum -a 256
```
