# TNG-90 — design conformance of the shipped workspace against the approved design

- **Date:** 2026-09-11
- **Checked by:** Product/UX Designer
- **Approved baseline:** TNG-87 design (`docs/DESIGN_LANGUAGE.md`, `docs/UX_REDESIGN.md`),
  TNG-89A interaction spec (`docs/TNG89_INTERACTION.md`), prototype tokens
  (`docs/mockups/tokens.css`)
- **Subject:** the prompt-to-output workspace described by
  `docs/decisions/0009-prompt-to-output-workspace-shipped.md` (uncommitted working tree)
- **Verdict:** **conformant** on the design-system layer (§§1–3), with one documentation gap
  in the vocabulary (§4). **Not conformant on the accessibility layer** — five §6 contracts
  were unmet on surfaces that ship today (§6) — all five have since been closed by TNG-158.
  **Not conformant on the honesty layer** (§7) — five contracts were unmet; B2 closed within
  the hour (TNG-158), B3/B4/B5 since (TNG-162), and the entity-level `capture` seam (B1) —
  the one defect that had outlived all three children — closed by TNG-170 (§7.4). **Not
  conformant on the response layer** (§8) — six §3.3–3.4 contracts were unmet, all six
  closed by TNG-166. **Not conformant on the narrow layer** (§9) — four §11.6 contracts were
  unmet below 768 px, all four closed by TNG-173. **Composer layer: audited at 5/13 and
  closed the same day** (§10, 2026-09-12) — eight §1 contracts were open, including the three
  the spec spends its prose defending: the two-step legibility of `Save & run`, one start key
  per attempt, and the revision the run actually executes. All three now hold. **Short-viewport
  layer: closed** (§11, 2026-09-12) — §13's clustering rule had shipped as a rule that deleted
  the prompt input and the submit control below 600 px of height; fixed, and now measured
  rendered as well as statically.
- **No layer is open.** Every probe exits `0`; the composer gate reads **14/14** and the
  short-viewport pair reads **5/5 static, 16/16 rendered**. §1 was the last section never
  checked against an implementation — §§6–9 each took a TNG-89A acceptance
  clause, and this one took the section the spec opens with. No layer here has ever blocked
  Gate B, which governs the design (§5), not this implementation — and §§10–11 add no bytes to
  the pinned prototype, so the pending card's hash is unchanged by them.
- **Green is the weaker claim.** A gate whose rows all pass cannot show that its selectors
  still bind, so each section's rows are proven individually defeatable rather than merely
  green (§10.6 for the composer). Two composer rows were scoring against comment text and one
  against the wrong leg of a disjunction; all three were found that way, not by reading counts.
  **As of 2026-09-12 every gate here has a committed counterfactual.** The last one without was
  §1's — the gate that had already gone blind twice — and its stand-in was a table in prose
  that shipped with a row scored wrong. §1.4 replaces it with a harness, and defeats that
  harness four ways before believing it.
- **Six sections are historical.** §6, §7, §8, §9, §10 and now §11 record contracts and
  reasoning, and their verdicts are the state at the moment of observation. The probes are the
  only current answer — run them; do not read a count off this page.

This checks the implementation's *claims* against the approved design. It does not review
code quality, and it does not touch the Gate B artifact — see §5.

**Revision history.** §§1–5 were written 2026-09-11 and published at commit `818dbef`; §6 was
added the same day, after the token pass, when the interaction layer — a TNG-89A acceptance
criterion that had never been checked against an implementation — was audited. §7 followed,
covering the one remaining layer TNG-89A puts an acceptance criterion on: evidence quality.
§§6–7 read only production source and add no bytes to the pinned prototype; §5 still holds.
§8 was audited by the same probe discipline at `72c0ca4` — six §3.4 contracts on the
response node, all open — and closed the same day by TNG-166; its backend half (the daemon
emitting the code the strip now carries) is TNG-168's. §9 followed, on the one TNG-89A
acceptance clause left unchecked: responsive behaviour below 768 px. Unlike §§6–8 it is
*not* bytes-neutral on the prototype — §8's finding sent a thirteenth screen into the
artifact, which is why §5 now opens by saying so. §10 was audited 2026-09-12 on the prompt
composer (§1), the one section of the interaction spec no probe had ever read; it is
bytes-neutral on the prototype, and unlike §§6–9 its gate was mutation-audited **before**
publication rather than after a false green (§10.5). §§1–2 were **re-measured 2026-09-12**
and had gone red since publication: the implementation had grown two shell metrics the gate
had never been told about, and had dropped an elevation primitive's WebKit prefix. Both are
reconciled in §1.1 — the numbers in §1 and §2 below are the re-measured ones. Auditing that
fix then found a second defect in the gate itself (§1.3): reconciling §1.1 had left it unable
to fail on a dropped primitive at all, so §2's nine lines are now enforced line-for-line
rather than printed as a count. §11 was written 2026-09-12 from the TNG-201/TNG-203 record,
which until then lived only in an issue document — **and its four gate files had never been
committed**, so the evidence certifying that fix was the one gate suite of eight that a
reviewer at a clean checkout could not run. They are tracked as of this revision. §1.4 then
closed the last hole of the same shape from the other direction: with §13 committed, §1 became
the only gate here with **no counterfactual at all** — the one gate that had already gone blind
twice. `defeat-token-conformance.py` makes its counterfactual runnable, and §5.2 re-runs all
eight against the pinned artifact now that two of them have changed since §5.1 measured them.

## 1. Design tokens — PASS, zero drift

ADR 0009 claims tokens were "lifted verbatim" from `docs/mockups/tokens.css`. Checked by
parsing both files into `name → value` maps per theme tier and diffing.

Approved blocks: `:root` (83) + `[data-theme="light"]` (24) + `[data-theme="dark"]` (24).
Shipped blocks: `:root` (86) + `@theme` (26) + `[data-theme="dark"]` (24). Light moved from
a `[data-theme="light"]` block into Tailwind's `@theme`, per ADR 0009 decision 4.

| Theme | Approved tokens | Missing | Value drift | Extra |
|---|---|---|---|---|
| Light | 107 | **0** | **0** | 7 |
| Dark | 107 | **0** | **0** | 7 |

Every one of the 107 approved tokens resolves to a byte-identical value in both themes. The
7 extras are not design tokens: `--color-black`, `--color-white`, `--color-transparent` are
Tailwind's `@theme` plumbing (with `--color-*: initial` clearing its defaults), and
`--lw-bottom-offset`, `--lw-composer-w`, `--lw-schedule-w` and `--lw-viewctl-clear` are
app-shell layout metrics with no counterpart in a static prototype.

The claim holds exactly.

### 1.1 The two-day drift, and why it was not visible on the page (2026-09-12)

Re-running the gate on 2026-09-12 returned **FAIL** on both themes, still at `missing=0
drift=0` — nothing approved had moved. Three differences had appeared since publication, and
none of them is the kind of failure the count in the table above can show:

| Difference | Verdict | Disposition |
|---|---|---|
| extra `--lw-schedule-w: 360px` | not drift — an app-shell metric, consumed by `.lw-schedule-panel` (`app.css`) | declared in `ALLOWED_EXTRA` |
| extra `--lw-viewctl-clear: calc(36px + var(--lw-panel-inset) + var(--sp-3))` | not drift — an app-shell metric from the §13 short-viewport work, consumed by `.lw-activity` (`runtime.css`) and the right panel `max-height` (`app.css`) | declared in `ALLOWED_EXTRA` |
| `.e1` had lost `-webkit-backdrop-filter: blur(20px)` | **regression** against the approved primitive | line restored in `ui/src/styles/tokens.css` |

The first two are the same category as the two metrics already listed — the gate failed them
only because it had never been told they exist, which is the behaviour it is supposed to
have. Each is now declared with *the rule that consumes it*, so an entry added to silence the
gate rather than to describe the app is visible as an entry whose consumer cannot be found.

The third is a real one, and worth being precise about how real. **It is not a visual defect
on the engine the board reviews in.** Measured, rather than assumed, against the WebKit the
board sees (`AppleWebKit/605.1.15`, via `verify-webkit.swift`): a rule carrying only the
unprefixed `backdrop-filter: blur(20px)` computes to `blur(20px)` for *both* `backdropFilter`
and `webkitBackdropFilter`, and `CSS.supports` answers true unprefixed. So the glass on `.e1`
blurs in Safari today with or without the prefix. What the missing line costs is older
WebKit — Safari before 18 and the iOS WKWebViews that track it, where unprefixed
`backdrop-filter` is inert and `.e1` falls back to a flat translucent fill. The approved
primitive carries both lines; production carried one; restoring it costs a line and nothing
else, since engines that honour the unprefixed property resolve both to the same value.

It also explains the §2 count. §2 was published at **9 differing lines in three places**, all
three ruled intended. The 2026-09-12 run read **10 lines in four places** — the tenth being
this dropped prefix, which no §2 ruling covered. With the line restored the diff is 9 lines
in the same three settled places again, which is the check that the tenth line was the whole
of the regression and not a symptom of something larger.

### 1.2 The widened allowlist, audited before it was trusted

Adding names to `ALLOWED_EXTRA` is the one edit that can turn this gate green by blinding it,
so the green above is not the evidence — these counterfactuals are, each applied to
`ui/src/styles/tokens.css` and reverted:

| Mutation | Required | Observed |
|---|---|---|
| `--lw-chip-h: 44px` → `40px` | drift caught | `FAIL … drift=1`, `DRIFT --lw-chip-h`, both themes — exit 1 |
| add `--lw-invented-x: 9px` | an undeclared extra still fails | `FAIL … unexpected-extra=1`, `EXTRA --lw-invented-x`, both themes — exit 1 |
| re-drop `-webkit-backdrop-filter` | the dropped primitive fails | `FAIL primitives: 10 differing line(s), 9 ruled, 1 undeclared` — exit 1 |
| widen the focus ring to also match `summary` | a *ruled* line that moves still fails | `FAIL primitives: … 8 ruled, 1 undeclared` + `STALE declaration` — exit 1 |

So the two new entries bought silence for exactly themselves: a value that moves, a token
invented and never reconciled, and a primitive quietly dropped are each still caught.

### 1.3 The third counterfactual did not hold when §1.2 was first written (2026-09-12)

Run rather than read, the prefix row came back **exit 0**. `check_primitives()` was
*reported, never failed* — by design, since the restructure §2 rules intended would otherwise
be permanent red — so re-dropping the prefix moved a printed count from 9 to 10 and returned
success. The row as first published required only that "the §2 tripwire still moves," which is
what was observed; it is the acceptance criterion, that the re-dropped prefix **fail**, that
was not met.

This is worth stating plainly because the gap ran the wrong way. Before §1.1, the gate was red
— but red for the two undeclared shell metrics, *not* for the prefix. Declaring them turned
the only signal off: a second prefix drop would have exited 0 with the regression printed in
prose above the summary, which is the one place a reviewer reading an exit code never looks.
Fixing §1.1's finding had made the gate blind to the very defect class that produced it.

The fix is to gate the primitive diff rather than print it. `RULED_PRIMITIVE_DIFF` now names
the nine lines §2 ruled intended, **line-for-line rather than as a count**, and any differing
line outside them fails. A count cannot distinguish nine expected lines from eight expected
plus one regression — which is exactly how `.e1` went two days with a missing prefix while
this section read PASS. The fourth counterfactual above is that distinction under test: it
holds the total at nine and still fails, because the line that changed is not one of the nine.

A ruled line that stops appearing is reported as `STALE` and does **not** fail. Convergence
toward the approved file is not a conformance failure; it just leaves a declaration describing
a difference that no longer exists.

### 1.4 The counterfactual is now a committed harness, not a hand pass (2026-09-12)

§1.2 and §1.3 together are an argument for distrusting this section's green, and the argument
is stronger than either one alone:

- §1.1 — the gate read **PASS for two days** while `.e1` was missing a primitive.
- §1.3 — the **repair** for that left the gate unable to fail on a dropped primitive at all.
- and §1.2 — the counterfactual table meant to catch exactly that was **published with a row
  scored wrong**, because it was reasoned about rather than run.

Three different failures, one shape: the gate was believed on the strength of its output. Every
other gate in `docs/mockups/` already answers this with a harness that defeats it on purpose —
`defeat-composer-conformance.py` (§10.6), `defeat-short-viewport.mjs` (§11.4),
`verify-prototype.mjs`'s counterfactual pass. The gate with the worst record had none, and its
counterfactual lived here as a table in prose, which is the format that let §1.2's row through.

`defeat-token-conformance.py` makes it executable. It stages the gate and both its inputs into
a scratch tree — the gate resolves its paths from `__file__`, so staging it beside staged
inputs redirects it without editing it, and `ui/` is never written — then applies eight
defects one at a time. Each is scored on **three** properties, not one:

| | Mutation | Must redden | Must print |
|---|---|---|---|
| T1 | an approved token is dropped from `ui/` | `light`, `dark` | `MISSING --lw-obsidian-950` |
| T2 | an approved token's value drifts | `light`, `dark` | `DRIFT   --lw-obsidian-950` |
| T3 | an undeclared token appears in `ui/` | `light`, `dark` | `EXTRA   --lw-bogus-metric` |
| T4 | a **dark-only** token drifts | `dark` **only** | `DRIFT   --color-ground` |
| T5 | the **approved** side is edited instead | `light`, `dark` | `EXTRA   --lw-obsidian-950` |
| P1 | §1.1 verbatim — `.e1` loses `-webkit-backdrop-filter` | `primitives` | `UNDECLARED -  -webkit-backdrop-filter…` |
| P2 | a primitive's value changes | `primitives` | `UNDECLARED +  backdrop-filter: blur(12px);` |
| P3 | an unreviewed primitive rule is added | `primitives` | `UNDECLARED +.lw-bogus-primitive…` |

**8/8 detected, by exactly the check that owns them.** The third column is what a
"did the exit code change?" harness skips, and it is the one that separates *the gate noticed
this* from *the gate noticed something*. The second column is matched **exactly**, not as a
subset: a token defect that also reddens `primitives` would mean the two halves are scoring
each other's work, which is the entanglement §1.3 had to unpick. T4 and T5 exist for the two
defects an inattentive gate passes — a dark regression masked by a correct light value, and a
prototype quietly rewritten to match production instead of the other way round.

Two things a mutation cannot reach are checked directly:

- **Allowlist integrity.** `ALLOWED_EXTRA` is this gate's only widening seam, and §1.2 exists
  because widening it is how the gate would be blinded. Its docstring promises each shell
  metric "names the rule that consumes it" — that promise was prose. Now every entry must be
  *declared* in `ui/` (a dead entry suppresses nothing today but silently pre-authorises that
  token's return) and every `--lw-*` entry must be `var()`-consumed by a rule under `ui/src`.
  All 7 pass; the three `--color-*` are Tailwind plumbing consumed as generated utilities, not
  through `var()`, and are exempted by name rather than by accident.
- **The refusal path.** Run against an extracted Gate B pin there is no `ui/` to read, and the
  answer must be `CANNOT RUN` (exit 2) with **no traceback** — a stack trace in a reviewer's
  terminal is indistinguishable from a finding against the artifact under review. Checked from
  both sides, shipped-absent and approved-absent.

**And the harness was itself defeated before being believed**, since a harness that has only
ever printed green is the same trap one level up. Four blindings were applied to scratch copies
of the gate; each must be caught, and caught *with the right diagnosis*:

| Blinding applied to the gate | Harness verdict |
|---|---|
| `undeclared = []` — §1.3's blindness, restored | exit 1, **P1/P2/P3 survived** — named as survivors, with §1.1 quoted as why it matters |
| add `--lw-bogus-metric` to `ALLOWED_EXTRA` — green a gate by widening the seam | exit 1, **T3 survived** *and* the new entry flagged as undeclared and unconsumed |
| add a dead `--lw-never-declared` entry | exit 1, allowlist integrity flags it — mutations all still pass, so the finding is isolated |
| delete the `check_inputs()` guard | exit 1, refusal path reads `exit=1 says-cannot-run=NO traceback=YES` |

Against the real tree it exits 0. The rule this section leaves behind: **a counterfactual
written as a table is a claim; a counterfactual written as a script is a check.** §1.2 was the
former and had a wrong row in it for a day.

## 2. Typography, elevation and focus primitives — PASS

The non-token remainder of the two files (all ten `.t-*` type ramps, `.tnum`, `.e1`/`.e2`
elevation, the focus-visible ring, the reduced-motion query) differs by **9 lines**, in
three places — all three intended. Since 2026-09-12 these nine are declared in the gate as
`RULED_PRIMITIVE_DIFF` and enforced line-for-line, so this section is now measured rather
than read: a tenth line, or one of the nine changing shape, fails (§1.3). The three:

1. The light selector changed from `:root, [data-theme="light"]` to `@theme` +
   `:root` (ADR 0009 decision 4). This is not an implementer's liberty: the approved
   `tokens.css` header *instructs* it — *"written to be liftable almost verbatim into
   `ui/src/index.css`: swap the `@theme { }` wrapper back in for the light tier-2 block."*
2. Focus-visible **widened** from `button, [role="button"], a, input, [tabindex]` to also
   include `textarea, select`. This is a correction in the spirit of §6.1, not drift — the
   composer is a `textarea` and would otherwise have taken no visible focus ring.
3. `[data-motion="reduce"] { --bloom: none; }` is dropped. Correct — see §3.

Everything else, including all ten type ramps, matches byte for byte.

This count went to **10 lines in four places** between publication and 2026-09-12 and is back
to 9 — the fourth place was a dropped `-webkit-backdrop-filter` on `.e1`, restored; §1.1 has
the measurement. Read the count as a tripwire, not as a score: the three places above are
ruled, so *any* fourth is by definition something nobody has ruled on yet.

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

## 5. What this touches — the artifact moved once, deliberately

For §§1–4 and §§6–8 this held: those sections read only production source and added no bytes
to the pinned prototype, so the Gate B card pinned to `83b4a49` stayed valid and reproducible
against it. **§8 broke that, and it was right to.** TNG-166 found the implementation reporting
a clean run that produced no answer as `process_crashed`. The spec had always separated the
two (§3.4); the prototype had only ever *drawn* the crash. A state the reference artifact
never draws is a state an implementer has to invent — so it got invented wrong. Fixing only
the code would have left the artifact able to cause the same defect again.

So the prototype gained a thirteenth screen, `#unanswered`, and
`docs/TNG89_INTERACTION.md` §3.4 gained the paragraph it renders. The consequence is
mechanical and must not be glossed: **`prototype-standalone.html` on disk is no longer the
file at `83b4a49`.** It hashes `a339e26a…`, not the card's `9b3391a6…`. The pinned card is
therefore not reproducible against the bytes a reviewer opens, and it under-describes the
artifact by one screen. It was withdrawn and re-issued against the commit that carries this
section rather than left pending — a card whose `shasum` step fails in the reviewer's own
terminal is worse than no card.

The §4 vocabulary gap is still not a reason to touch the artifact: that one is between the
spec and an implementation the card does not cover.

### 5.1 Re-verified at publish time, not at pin time (2026-09-12)

The card now pending names `968ce80` / `sha256 a339e26a…`, and it has stayed open across ten
commits under `docs/mockups/`. None of them touched the artifact — they were gates, probes and
write-ups — but several existed *specifically to fix checks that could not fail* (`575a96a`,
`4ddd2d0`, `bc015db`, `a042dde`, `cd72d7d`). **A pin verified once by gates that have since
been rewritten is not a verified pin.** So the current gates were re-run against the pinned
bytes rather than the earlier pass being trusted:

| Check | Result |
|---|---|
| `git show 968ce80:…/prototype-standalone.html \| shasum -a 256` | `a339e26a…` — and identical at `HEAD` and in the working tree |
| `verify-tng90-states.mjs` (reads the artifact) | **47 passed, 0 failed** |
| `verify-prototype.mjs` (reads the artifact) | green |

The implementation gates are green too, but they are not Gate B's subject and a pass there is
not evidence for the card — §1's gate was **red** at the same moment all of the above was
green, which is the whole reason to keep the two families apart when reporting to the board.

The rule this section already states, generalised: the pin is a claim about bytes *and* about
what the gates say about those bytes. Only the first half is frozen by a hash. Re-run the
second half before every publication, and before answering "is it still good?".

### 5.2 Applying §5.1's own rule to §5.1 (2026-09-12, 15:15)

§5.1 was written at `99a7374`. **Two gates changed after it**, which is precisely the situation
it says invalidates a re-verification:

- `6987836` un-blinded the token gate (§1.3) — the version §5.1 ran was the blind one.
- `0afccee` committed the §13 short-viewport suite, which until then existed only in a working
  tree, so it was the one gate of eight a reviewer at a clean checkout could not run at all.

So §5.1's own table is stale by its own argument. All **eight** gates re-run at `HEAD`
(`0afccee`), the artifact re-extracted from the pin rather than read off disk:

| Gate | Reads | Result |
|---|---|---|
| `shasum -a 256` on the extracted pin | **the pinned artifact** | `a339e26a…` — identical at `968ce80`, `HEAD` and the working tree |
| `verify-tng90-states.mjs` | **the pinned artifact** | **47 passed, 0 failed** |
| `verify-prototype.mjs` | **the pinned artifact** | **pass** |
| `verify-token-conformance.py` | working-tree `ui/` | clean, 0 drift · primitives 9/9 ruled |
| `verify-composer-conformance.mjs` | working-tree `ui/` | 14/14 |
| `verify-evidence-honesty.mjs` | working-tree `ui/` | 5/5 |
| `verify-response-states.mjs` | working-tree `ui/` | 6/6 |
| `verify-a11y-conformance.mjs` | working-tree `ui/` | 5/5 |
| `verify-narrow-conformance.mjs` | working-tree `ui/` | 4/4 |
| `verify-short-viewport.mjs` | working-tree `ui/` | 5/5 |

`git log 968ce80..HEAD -- docs/mockups/prototype-standalone.html` is still empty. The top three
rows are the only ones that speak to Gate B; the rest read uncommitted production source and
are reported for completeness, not as evidence for the card.

**Two things the pending card now states slightly stale, neither of them about the artifact.**
Recorded here rather than fixed by re-issuing, because the ask has already been withdrawn and
re-posted nine times and a tenth would cost the board its queue position to correct a label:

1. Its table labels `1a641f5` as `HEAD`. `HEAD` is now `0afccee` — four commits later, all four
   confined to `docs/mockups/` (`.md`, `.py`, `.mjs`, `.js`). The row's *claim* — 55 tracked
   `ui/src` files, 0 `tsc` errors — is unchanged by them.
2. Its gate table lists seven gates; there are now nine rows above. The two it omits are the
   token gate (which was red when the card was written, and is the subject of §1.1–§1.4) and
   the §13 suite (which was uncommitted when the card was written). Both are green. The card
   understated the evidence; it did not overstate it.

## 6. Accessibility — FAIL as audited; all five closed by TNG-158 the same day

§§1–4 checked the design-*system* layer. This section checks the interaction layer:
`docs/TNG89_INTERACTION.md` §6 (focus order, live regions, accessible names), which
TNG-89A lists as an acceptance criterion and which had never been checked against an
implementation. Every rule is asserted by `docs/mockups/verify-a11y-conformance.mjs`,
which exits non-zero while these are open and zero once they are closed.

| ID | Spec | Surface | Result |
|---|---|---|---|
| A1 | §6.4 entity name | `ProvenancePanel` entity row | **FAIL** |
| A2 | §6.4 summary chip name | `ProvenancePanel` zone-head | **FAIL** |
| A3 | §6.1 summaries in tab order | `ProvenancePanel` zone-head | **FAIL** |
| A4 | §6.3 preflight is assertive | `Workspace.politeAnnouncement` | **FAIL** |
| A5 | §6.3 no message is dropped | `Workspace.politeAnnouncement` | **FAIL** |

### 6.1 Accessible names (A1, A2)

§6.4 fixes an entity's name as `"<kind>: <name>, <capture word>"`. The panel's entity
rows (`ProvenancePanel.tsx:78`) carry no `aria-label`, so the name is computed from child
text — and the one child that could carry kind or status is a `StatusGlyph`, which is
`aria-hidden` (`glyphs.tsx:86`). A screen reader hears `"Fetch page #04 · 12.3s"`: no
kind, no capture word. The two channels §5.1 requires the word for — telling `recorded`
from `derived` from `redacted` from `unavailable` — are both unavailable non-visually,
which is the exact failure §5.1 exists to prevent.

The canvas `EvidenceNodeCard` does better (`StoryNodes.tsx:56`) and names kind, owner and
status. It still omits the capture word, but it is not the regression the panel is: the
panel ships the same entities with strictly less information.

A2 is minor and recorded for completeness — the summary announces `"tools 4 complete"`,
dropping the contract's `entities` noun, so the count is spoken with no unit.

### 6.2 Tab order (A3)

§6.1 position 4 puts *"the six summaries in fixed order"* in the tab sequence. They are
rendered as plain `<div class="zone-head">` (`ProvenancePanel.tsx:65`) and cannot take
focus, so those six positions do not exist. The entity rows beneath them *are* buttons, so
keyboard users reach the leaves without ever reaching the grouping that explains them.

### 6.3 Live regions (A4, A5)

Two distinct defects, both in `Workspace.tsx:616-625`.

**A4 — wrong channel.** §6.3 lists preflight blockers as **assertive**. The blocker
(`documentChipState === 'invalid'`, the "N things to fix before this team can run" state
built at `Workspace.tsx:489`) is published only on the polite region at line 622.

**A5 — the queue drops messages.** `politeAnnouncement` is a list of candidate messages
resolved with `.find(Boolean)`, so **at most one is ever announced**, and the rest are
discarded rather than queued. `statusAnnouncement` sits second in that list and holds
agent task-state churn for 3 s at a time (`Workspace.tsx:474-475`). During a live run it
is therefore almost always truthy, and it silently preempts everything below it: save
state, the validation blocker, disk notices and start errors. The four things an operator
most needs to hear are the four the implementation is most likely to swallow.

`startError` survives only because it has a second, independent `role="alert"` bar
(`Workspace.tsx:723`). Nothing else below `statusAnnouncement` has that backstop.

### 6.4 Deliberately not counted as defects

- **§6.2's synchronized `role="tree"` outline is absent** (no `role="tree"`, no `⌘⌥O`, no
  ⌘K route). §6.2 attributes it to `TNG-89F`, which is open and `blocked`. Out of scope
  for the shipped workspace, not a regression against it.
- **§4.1's one-hop canvas expansion** is likewise `TNG-89F`'s. What ships is a flat panel
  listing every entity per category at once. Correct as an interim surface; A1–A3 are
  scored against that panel as it actually ships, not against the canvas it will become.
- **Response name wording.** §6.4 specifies `"Response from <agent>, <run state>"`;
  shipped is `"Output response from <agent>, <phase>"` (`StoryNodes.tsx:82`). Both facts
  the contract requires are present. Wording variance, not a defect.

## 7. Evidence quality — FAIL as audited; all five closed, B1 last by TNG-170

§6 checked whether provenance can be *heard*. This section checks whether it tells the
truth. The subject is `docs/TNG89_INTERACTION.md` §5 — the section the spec itself calls
*"the honesty layer"* — read against its two upstream authorities,
`docs/RUN_PROVENANCE_CONTRACT.md` §8.1 (`capture`) and §12 (the capture-coverage matrix).
TNG-89A lists §5 as an acceptance criterion. Like §6, it had never been checked against an
implementation. Every rule below is asserted by `docs/mockups/verify-evidence-honesty.mjs`.

| ID | Spec | Surface | Result |
|---|---|---|---|
| B1 | §5.1 / CONTRACT §8.1 — `capture` is modelled | `events.ts` `interface Evidence` | **FAIL** |
| B2 | §5.1 — the capture word is never omitted | panel row · `EvidenceNodeCard` · `RunColumn` | **PASS** (landed mid-audit) |
| B3 | §5.2 — `partial` is reachable | `ProvenancePanel.coverageFor` | **FAIL** |
| B4 | CONTRACT §12 — agents complete only on terminal evidence | `events.ts` `coverage.agents` | **PASS** (landed mid-audit) |
| B5 | CONTRACT §12 — tools complete only when calls are paired | `events.ts` projection boundary | **PASS** (landed mid-audit) |

> **The table above is a timestamp, not a scoreboard — run the gate.** §7 was written
> against the tree at commit `349207d`, where all five failed. It was overtaken twice while
> being written: TNG-158 landed and closed B2, then TNG-162 landed and closed B4 and B5,
> going further than asked and publishing a real per-category `level` with stable reason
> codes (`unpaired_calls`, `agents_awaiting_terminal_evidence`, `unprojectable_events`)
> rather than patching the two counts. B3 has since closed as well, and TNG-170 has since
> closed B1 — so every row in the table above now reads PASS, and this note has been
> overtaken a third time. Run the gate for the number; this note deliberately no longer
> carries one, having now been wrong three times. Anything here that reads as a verdict is
> the state at the moment it was observed;
> `node docs/mockups/verify-evidence-honesty.mjs` is the only current answer. The prose below
> is kept in the present tense of its observation because the *contract* and the reasoning
> are what this document is for, and those do not expire when a fix lands. Where a first
> draft said something later made false — §7.1 claimed no entity control carried a capture
> word — it has been corrected in place rather than left standing.

### 7.1 `capture` is announced but not modelled (B1, B2)

CONTRACT §8.1 makes `capture` a property of every entity, with four values and an exact
meaning each: `recorded` (explicit protocol or adapter evidence), `derived` (deterministic
relationship from recorded evidence), `redacted` (evidence exists, public fields removed by
policy), `unavailable` (not emitted, unsupported, malformed, or dropped by a declared
limit). §5.1 then puts all four on three channels — border, glyph **and** word — and says
the word *"is never omitted to save space."*

Of those three channels, exactly one now exists.

- **Word — present (B2).** TNG-158 put it in the accessibility tree on all three surfaces
  that render an entity control: the panel row (`ProvenancePanel.tsx:98`), the canvas
  `EvidenceNodeCard` (`StoryNodes.tsx:59`) and `RunColumn.tsx:68`. The word is `recorded`,
  and it is the **correct** word: the projector's only input is an accepted `RunEvent`, and
  CONTRACT §8.1 defines `recorded` as exactly *"explicit protocol or adapter evidence."*
  The comment at `ProvenancePanel.tsx:42-45` states that reasoning, which is what makes it
  checkable rather than assumed. This is the honesty layer's first working channel.
- **Border — absent.** The approved prototype ships `.cap-recorded` / `.cap-derived` /
  `.cap-redacted` (`docs/mockups/prototype.css:1437-1446`), including the diagonal hatch
  that says *"there is something here you are not being shown."* `grep -c 'cap-'
  ui/src/styles/*.css` is **0** across all three production stylesheets.
- **Glyph — absent.** `StatusGlyph` on every surface renders *run* status: succeeded /
  failed / running. That answers a different question — whether the tool call worked, not
  whether LoomWatch saw it.

**B1 is what remains, and TNG-158 sharpened it rather than closing it.** The word is now
asserted in three places and typed in none: a module constant at `ProvenancePanel.tsx:46`,
and a bare `recorded` literal inside the template string of `StoryNodes.tsx:59` and
`RunColumn.tsx:68`. `interface Evidence` (`ui/src/lib/watch/events.ts:110`) still has no
`capture` field, so CONTRACT §8.1's other three states are unrepresentable, and the first
entity that is genuinely `derived` or `redacted` makes two of those three call sites
silently wrong with no compiler seam to catch it. The value is right; the **shape** is the
thing that will not survive redaction landing.

Recorded as a *mild* defect, deliberately. Behaviourally the constant and the field are
identical today, and the uniform value is honest — which is why the a11y contract could
close ahead of the modelling one. The cost is latent, not live.

§5.1 cites `TNG-89F` as the origin of the requirement, and the border and glyph treatments
are fairly TNG-89F's to ship on the expandable canvas. B1 is not TNG-89F's: a field on the
projection is the precondition for every surface, present and future, and it is also what
would let §7.2's coverage stop guessing.

**A note on how this was avoided.** TNG-158's implementer and this audit reached the same
ruling independently and within the same hour — `recorded`, justified from the accepted-event
invariant, with `unavailable` left at the category level and no code path emitting `derived`
or `redacted`. That was the outcome worth protecting: a fabricated capture word would have
been a worse defect than the silent one it replaced, because it would have put a false claim
about evidence quality on the one surface whose entire job is not to make them.

### 7.2 The graph can claim capture it has not achieved (B3, B4, B5)

CONTRACT §12: *"Each category publishes `level: complete|partial|unavailable` … A
graph-level 'complete' label is allowed only when every requested category is complete."*
§5.2 restates it as the sentence that keeps the view honest.

Production does not read a published level. `ProvenancePanel.coverageFor` (line 32)
computes one:

```ts
return projection.coverage[key] > 0 ? 'complete' : 'unavailable'
```

Three defects follow from that one line.

**B3 — `partial` is unreachable.** The expression has no `partial` branch, so the middle
level never occurs. `CoverageGlyph`'s half-dot (`glyphs.tsx:133`) and the panel's
`` `${listNames(labels)} partial` `` clause (line 47) are dead code: correct, reviewed, and
unrenderable. The contract names two paths that must produce it — §10's `projection_limit`
(*"coverage becomes partial"*) and §11's malformed event (*"graph skips it and coverage is
partial"*). Both currently surface as `complete`, because the surviving evidence still
counts above zero. A run that silently lost entities to a limit is indistinguishable from
one that lost nothing.

**B4 — a spawned agent is treated as a finished one.** §12's agents row is complete only
*"when every spawned agent has identity and terminal evidence."* `coverage.agents` is
`list.length` (`events.ts:530`) — byte-identical to `totals.agents` on line 527, which is
the headcount. Coverage for agents *is* the headcount under another name. So agents reads
`complete` from the first spawn, while every agent is still running. The terminal facts
are already projected and one field away: `ProjectedAgent.exitCode` and `.stopReason`
(`events.ts:102-103`) are never consulted by the coverage path.

**B5 — an unpaired tool call counts as a captured one.** §12's tools row is complete only
when *"every call is paired or terminally failed."* The projector does track unpaired
calls — and then discards the field at the boundary:

```ts
agents: list.map(({ streaming: _s, thinking: _t, turnText: _x, openCalls: _o, handedOff: _h, ...agent }) => agent)
```

`openCalls` is computed per agent and stripped on the way out, so the single fact that
decides tools coverage is produced and thrown away by the same function.

**What this reads as on screen.** The header (`ProvenancePanel.tsx:55`) consults only the
six derived levels; it never consults `projection.phase`. Its tooltip — *"Complete for
what the adapters can observe"* — is the honest scoping sentence §5.2 asks for, attached
to a label that has not earned it. Once a run has produced at least one item in each of
the six categories, the panel says **"Complete capture"**, and it will say so while the
run is still streaming, while calls sit unpaired, and after a trace limit has dropped
entities. That is the precise overclaim §5.2 was written to forbid.

The good news is that the gap is small in code: B4 and B5 are satisfiable today from facts
the projector already has. B1 and B3 need the level and `capture` to be carried, which is
where this stops being the UI's decision alone.

**Filed, and closed.** B2 was `TNG-158`'s; the ruling on what the capture word may
honestly say is in that issue's `a1-capture-word-ruling` document. B3/B4/B5 are `TNG-162`,
which closed all three by doing the harder correct thing — the projector now publishes
`level` + `reason` + `observed` per category instead of a count (`CategoryCoverage` in
`events.ts`), which is what CONTRACT §12 actually asks for:

- **B4** — agents read `complete` only when every spawned agent has terminal evidence
  (`exitCode`, or a crashed/handed-off/stopped end); an agent still working reads
  `partial` with reason `agents_awaiting_terminal_evidence`. The headcount survives only
  as `observed`.
- **B5** — `openCalls` is no longer stripped at the projection boundary: it is published
  per agent, and tools read `complete` only when every call is paired or terminally
  failed (`unpaired_calls`), with a skipped archived update forcing `partial`
  (`unprojectable_events`, §11). A call deduped as a bus echo (§4.5) is dedup, not loss.
- **B3** — `partial` is reachable and the panel reads it: `coverageFor` returns
  `projection.coverage[key].level` and never invents a level from a count, and the
  projector leaves one seam where a daemon-published level (`§10 projection_limit`,
  `RunContext.publishedCoverage`) overrides the derived one. The gate's B3 check was
  re-anchored for this shape — it now asserts both halves (the level is carried, and the
  panel reads it) and is stronger than the original, which only asked for a `'partial'`
  literal in the panel.

**B1 is the remaining seam**, on the entity axis — `capture` on `Evidence` rather than a
word hardcoded at three call sites. The gate reads `4/5` with exactly B1 outstanding.

**B1 now has its own issue** (`2b9a0e34`), because it had stopped having an owner. It was
recorded above as `TNG-158`'s, and TNG-158 closed correctly on its own five accessibility
contracts without it — leaving B1 real, failing, and assigned to a closed issue. All three
TNG-90 children (TNG-158, TNG-162, TNG-166) are now done and `verify-evidence-honesty.mjs`
still exits `1`, so the gap is not a scheduling artifact that the next child would have
swept up. The scope boundary from §7.1 carries over: the new issue owns the **projection
field only**; the border and glyph channels stay `TNG-89F`'s. *(B1 has since closed —
§7.4 records what closed it and how the probes were re-anchored.)*

### 7.3 Deliberately not counted as defects

- **The empty-category reasons are right, and they are the part that works.**
  `EMPTY_REASONS` (`ProvenancePanel.tsx:20-27`) gives each category a real reason rather
  than a restatement of its count — *"Commands appear only when the adapter reports an
  `execute` tool kind"*, *"Prompt or filesystem presence alone is never treated as use."*
  That is exactly §5.1's *"an honest boundary"* requirement, met. `unavailable` at the
  **category** level is conformant; B1/B2 are about the **entity** level.
- **No keyhole.** §5.1 forbids hover-to-reveal or "request access" on a redacted node.
  Nothing in production offers one — trivially, since nothing is redacted, but the
  affordance is also absent by construction. Recorded so a future implementation does not
  reintroduce it.
- **Backend redaction is unimplemented** (`grep -ri redact crates/loomwatch-backend/src`
  is empty) against ADR 0005 §7's fail-closed policy. Real, but a backend contract gap,
  not a design-conformance finding, and out of this audit's scope. It does mean `redacted`
  genuinely cannot occur today — which is why B1's fix can ship honestly with a narrow
  set of reachable values rather than waiting on the full four.
- **Gap-clause wording.** §5.2's example reads *"Partial capture — skills and commands not
  captured"*; shipped is *"Partial capture — nothing captured for skills and commands."*
  Both name the gaps in full with no truncation, which is what the contract requires.
  Wording variance, not a defect.

### 7.4 What closed B1 (TNG-170)

The projection now carries the field, and the word's single source moved from the
surfaces to the projector:

- **`capture` is modelled** (`events.ts`). `export type Capture = 'recorded' |
  'derived' | 'redacted' | 'unavailable'` admits exactly §8.1's four values, and
  `interface Evidence` carries it — as does `interface ProjectedAgent`, because §8.1 makes
  `agent` an entity kind and the panel's agent rows speak the same word. The agent surface
  is the one call site the old constant had that the issue's list of three did not name;
  leaving it hardcoded would have recreated B1 one row over.
- **The projector sets it from the one invariant it can justify.** The block comment at
  the top of `projectRun` states the reasoning where it stays checkable: every projected
  entity — agents and evidence alike — is built solely from accepted `RunEvent`s, which
  §8.1 defines as exactly `recorded`, so `recorded` is the only value the projector sets.
  No code path produces `derived` (nothing synthesises an entity from other entities'
  evidence) or `redacted` (backend redaction is unimplemented, §7.3), and `unavailable`
  stays a category-level fact published by coverage — the type admits all four, the
  projector emits one, and fabricating any of the others is named in the comment as the
  worse defect.
- **No call site asserts a capture word.** The panel's `const captureWord = 'recorded'`
  is gone: the panel rows read `item.capture` / `agent.capture`, and the canvas card
  (`StoryNodes.tsx`) and its RunColumn variant read `evidence.capture` / `item.capture`.
  A first genuinely `derived` or `redacted` entity is therefore named truthfully with no
  surface edit — the compiler seam B1 lacked.

**Re-anchored, not weakened.** B1's original selector was still live and passed with the
field added; the probe was strengthened to also require the `Capture` type to name all
four §8.1 values, so a later code path cannot start emitting a state the type has
silently stopped admitting. B2 was re-anchored from "a capture-word literal is present"
to "each surface interpolates the entity's own `capture` field" — the literal check was
exactly what let the hardcoded constant go unnoticed. A1 (`verify-a11y-conformance.mjs`)
was re-anchored the same way; the entity-name contract itself is unchanged.

Verification: `node docs/mockups/verify-evidence-honesty.mjs` exits `0` — `5/5` for the
first time since the audit (the a11y gate stays `5/5`; the UI suite, `tsc -b` and
`oxlint` are clean). The border and glyph channels remain `TNG-89F`'s — §7.1's scope
boundary carried over: a field on the projection is their precondition, not their
replacement.

### 7.5 The gate itself, mutation-audited — two of five checks could not fail

Gate B card `0e52ed0c` cites this probe's `5/5` as the proof B1 closed. `4ddd2d0` had
already found one check in a sibling gate (D5, §3.4 `[ Reuse ]`) that could not fail on
the defect it named, and swept the siblings for the same weakness by running them against
a comment-stripped copy of `ui/`. **That sweep was half the class and could not have found
what follows.** It proves a check does not *depend* on prose in a tree where the feature is
present; it says nothing about whether the check can fail once the feature is *gone* and
the prose stays. D5 itself would have survived it — its bare `/Reuse/i` also matched the
live identifier `reusePrompt`.

So each contract was defeated one at a time, in a scratch copy, and the check that owns it
had to turn `FAIL`: `python3 docs/mockups/mutate-evidence-honesty.py`. Two of the five
could not.

- **B3 — the overclaim §5.2 forbids read `PASS`.** The surface-reader halves were
  `/coverageSummary\(|coverageFor\(/` over the raw file. Comment out
  `const level = coverageFor(category.key, projection)`, derive the level from
  `items.length` instead, and the gate stayed `5/5, exit 0` — it had matched the call
  inside the comment. This is D5's class exactly, one gate over. The alternation was the
  wider of the two holes: `coverageSummary` is §4.1's whole-run chip, so a surface could
  keep the chip honest while inventing every per-category level beside it and the check
  could not tell the two apart. Now: stripped source, and `coverageFor(` itself.
- **B5 — `tools` reading `complete` with calls still open read `PASS`.** The whole
  assertion was `!/openCalls: _/` on the agents mapping: the absence of one discard
  spelling. Delete the `unpairedCalls > 0 → partial` branch from the tools row — the exact
  defect B5's detail text describes — and it passed, because the spelling it watched was
  still absent; the defect had simply moved one expression away. **An absence check only
  covers the one shape somebody already thought of.** The contract is now asserted where
  it is decided, in three halves that fail independently: the tools row consults
  `unpairedCalls`, that count is derived from the projector's `openCalls` rather than a
  standing zero, and it still survives the projection boundary.

B1, B2 and B4 detected their defects unchanged. Nine mutations now run, including the
three evasions the strengthened checks must also catch (`M7`–`M9`), each keeping the token
the weaker check watched for while breaking the contract anyway; all nine are detected by
the owning check. The intact tree still reads `5/5, exit 0`, and against an extracted pin
the gate still exits `2` — `4ddd2d0`'s refusal is intact.

**Neither defect was in the implementation.** B3's and B5's contracts were met in the
shipped code throughout; the instruments were broken — which is worse, since these were
the evidence cited for B1's closure on a pending approval card.

## 8. The response node — FAIL as audited; all six closed by TNG-166

§§6–7 checked what the operator hears and what the evidence admits to. This section
checks the answer itself: `docs/TNG89_INTERACTION.md` §3.3–3.4 (the response node —
`partial` and `failed`), `docs/UX_REDESIGN.md` §16 (never paraphrase a daemon error) and
`docs/RUN_PROVENANCE_CONTRACT.md` §3 (terminal metadata carries a stable machine-readable
error code). Every rule is asserted by `docs/mockups/verify-response-states.mjs`, same
exit convention as §§6–7.

| ID | Spec | Surface | Result |
|---|---|---|---|
| D1 | §3.4 / CONTRACT §3 — the error code is carried, not invented | `client.ts` `RunRecord` · `Workspace.tsx` strip | **FAIL** |
| D2 | §3.4 — no code the daemon did not emit | `Workspace.tsx` strip watermark | **FAIL** |
| D3 | §3.4 / UX_REDESIGN §16 — the message slot is verbatim or explicitly absent | `Workspace.tsx` strip message | **FAIL** |
| D4 | §3.4 — `failed` renders as the strip, not a pending body | `StoryNodes.tsx` `OutputNodeCard` | **FAIL** |
| D5 | §3.4 — `failed` offers `[ Reuse ]` | `StoryNodes.tsx` `OutputNodeCard` | **FAIL** |
| D6 | §3.4 — a run with no canonical response is named, not called a crash | `events.ts` phase ladder · `Workspace.tsx` strip | **FAIL** |

Two independent shortcuts met on the one case the spec singles out by name.

**The strip's code was invented.** `RunRecord` carried `error` (prose) and `exitCode` and
no code field at all, so the watermark — rendered at `var(--font-mono)`, the typography of
a machine fact — was chosen client-side by whether a *prose string* happened to be
non-empty. A clean run with no error string was labelled `process_crashed`, the spec's own
example token for a crashed process, though nothing had crashed.

**The no-answer case was folded into `partial`.** The ladder's last rung was
`phase = responseText ? 'succeeded' : 'partial'`, so a run where every agent finished
cleanly and none was the canonical responder — `error` null, no crash — rendered
*"The run did not complete normally."* + `process_crashed`: the one terminal state §3.4
asks to be named in plain language was the one described as a crash.

### 8.1 What closed them (TNG-166)

- **D1/D2 — the strip no longer manufactures a code** (`Workspace.tsx:340-348`). The
  watermark resolves `record.errorCode ?? record.stopReason ?? projection.errorCode ??
  exit N`, and when the daemon reported none of these it renders `no code reported` —
  the honest absence, never a plausible token. `RunRecord` models `errorCode` /
  `stopReason` (`client.ts:28-31`), optional until the daemon emits them; the backend half
  — `RunRecord` gains `error_code`/`stop_reason` set at `mark_failed`, with
  `missing_canonical_response` as one stable code per CONTRACT §4 — is [TNG-168]'s, and
  the strip needs nothing further when it lands.
- **D3 — the message slot is verbatim or says it is absent.** The two manufactured
  sentences are gone. When the daemon said nothing, the strip says
  *"No error message was reported."* The one exception is §3.4's own prescription: the
  `missing_canonical_response` strip gets *"The run finished but no agent produced an
  answer."* — the spec's words for the UI's own observation, not a paraphrase of a daemon
  error.
- **D4/D5 — the failed node is the strip plus `[ Reuse ]`** (`StoryNodes.tsx:100-115`):
  the "yet" placeholder is gated to phases that can still answer, a terminally failed run
  renders no body, the accessible name stops crediting a producer that produced none
  (*"Output, Run failed."*), and `[ Reuse ]` copies the run's original prompt back into
  the composer (§3.2's own definition; the prompt survives on the Prompt node per §12.2,
  so this is a route, not lost data). `RunColumn.tsx:35` mirrors the same treatment at
  phone widths, where the response card is duplicated.
- **D6 — the ladder names the terminal no-answer run.** `events.ts:548-566` classifies
  terminal-with-no-canonical-response as `failed` (`missing_canonical_response`) instead
  of `partial` — gated on `context.evidenceComplete` (a terminal registry record with
  every archived event delivered, or a run the daemon no longer knows) *and* the cut
  reaching the end of what was delivered, so a quiet moment between two archived events,
  or a replay scrubbed short of the end, is never read as terminal. The projection
  publishes the classification as `errorCode` (`events.ts:603`); the strip displays it
  with §3.4's sentence.

Verification: `node docs/mockups/verify-response-states.mjs` exits `0` — `6/6`. The UI
suite is green (145 tests, including the new `projectRun` §4 classification cases and an
`OutputNodeCard` D4/D5 regression test), `tsc -b && vite build` and `oxlint` clean.

**D5 was a false pass until 2026-09-11, and the `6/6` above rests on the corrected
version.** The check was `/Reuse/i.test(outputCard)` — a bare, case-insensitive word over
the whole anchored region. Deleting the entire `[ Reuse ]` button still left it matching
two things that are not affordances: the destructured `reusePrompt` from
`useCanvasActions()` (`StoryNodes.tsx:87`) and the probe's own explanatory comment four
lines above the check. Demonstrated by removing the element and watching D5 report `PASS`
on a control the operator no longer had. It now strips comments from the region and
requires a `<button>` element carrying the visible `[ Reuse ]` label; the same deletion
now yields `FAIL D5 … 5/6, exit 1`, and the intact tree still reads `6/6`. The contract
was genuinely met the whole time — what was broken was the instrument, which is worse,
because it was the evidence cited for closing §8.

### 8.2 Deliberately not counted as defects

- **`partial` still consults `crash?.message`.** The archived crash event's payload
  message is the daemon's own words, verbatim — exactly what the slot is for. Only the
  *manufactured* fallbacks were removed.
- **`exit N` remains a watermark when the daemon reports no code** for a genuinely failed
  run. `exit 137` is a machine fact that names itself; it is not an invented code.
- **The cancelled strip keeps its prose.** "Cancelled by the operator. Partial answer
  kept." reflects the operator's own action back at them; it is not a daemon error being
  paraphrased.

## 9. Narrow and responsive behaviour — PASS, all four contracts closed (TNG-173)

§11.6 was the last TNG-89A acceptance clause never checked against an implementation.
AC #3 asks for *"light and black+gold dark themes, reduced motion, keyboard path, and
responsive behavior."* Themes are §1, reduced motion is §3, the keyboard path is §6.
Below 768 px is this section — and nothing had ever looked at it. It read `0/4` when first
audited; **TNG-173 closed all four**, and the gate now reads `4/4`.

`node docs/mockups/verify-narrow-conformance.mjs` reads production source and stylesheets
under the same discipline as §§6–8: every rule anchored to a line a reviewer can open,
`exit 2` if a selector drifts so a lost anchor can never read as a real failure.

### 9.1 The four contracts, and what closed each

- **N1 — the narrow column was missing three of its five stages.** §11.6 fixes the source
  order: *"… Output / response → coverage → filters → summaries → selected evidence →
  viewport-docked composer."* `RunColumn.tsx` rendered the last of those and none of the
  first three. **Closed:** a `.run-prov` section now follows the response in exactly that
  order — the §5.2 coverage sentence, the §4.4 filters, then §4.1's six fixed-order
  summaries. The overlay `ProvenancePanel` stays the one detail surface (§4.4: *"one detail
  surface in the product, not two"*), so the column states, filters and routes but never
  re-lists entities.
- **N2 — below 768 px the provenance panel could not be opened. Failure 22.**
  `ProvenancePanel` renders only while `provenanceOpen`, and its one writer was the Response
  node's toggle — inside the ReactFlow canvas that the narrow branch *replaces*. So §4.1's
  summaries and §4.4's filters were unreachable by pointer, by palette, and by shortcut.
  **Closed:** each of the six summaries opens the panel, and so does an explicit
  `[ Open full provenance ]`. Filtering no longer depends on the panel at all — it is in the
  column, as view state (§6.7), and it governs the evidence the run shows.
- **N3 — the core actions were 28 and 32 px, not 44. Failure 21.** The composer's Run /
  Save & run / Stop / Retry / New run (`.btn`, `height: 28px`), the run-history opener and
  theme toggle (`.iconbtn`, `32px`), and the mode chip (`min-height: 32px`, pinned inside a
  narrow block). None of the three `@media (max-width: 767px)` blocks lifted any of them.
  **Closed:** the narrow blocks lift `.btn`, `.iconbtn` and `.mode-chip` together, rather
  than by an ever-growing list of exceptions. `.pop-inline .btn` is restated because its
  24 px rule outranks `.btn` on **specificity**, not on source order — which is the one thing
  the declared-height probe cannot see, and the reason this contract also has a rendered
  confirmation (§9.2).
- **N4 — capture quality was spoken but never shown.** §11.6 concedes the edge geometry and
  the library at this width, but not what they carried: *"cards continue to state owner,
  event order/time, status, capture quality, and relationship."* The first four were on the
  card face; `item.capture` reached the accessible name only, and every *visible* rendering
  of the §5 honesty layer lived in `ProvenancePanel`, which N2 showed could not be opened.
  **Closed:** the card face carries the capture word (§5.1's *"the word is never omitted to
  save space"*), and the run's coverage sentence is now stated in the column itself.

**One honesty statement, not two.** The §5.2 sentence, the six categories and their empty
reasons moved to `ui/src/components/run/coverage.ts`, shared by the panel and the column.
Two independently built sentences could disagree, and a column reading "Complete capture"
over a panel that names gaps is the one failure §5 exists to prevent.

**A filtered view must never be able to look like a capture gap.** The summaries report the
projector's counts and levels whatever the filters are set to, and a filter that empties the
list says so — *"No evidence matches these filters. 2 entities were captured for this run."*
with its own way back. An emptied list that read as an empty run would be exactly the §5.1
confusion the honesty layer exists to prevent.

### 9.2 Confirmed in both directions, and then rendered

The gate read `0/4` against the tree and `4/4` against a scratch mirror of the same six files
with the minimal shape of each fix applied. Re-run after the fix, each contract was reverted
in that mirror one at a time and **each failed**, so none of the four is stuck-at-pass.

That exercise earned its keep twice, and both were false passes this file would otherwise
have shipped:

- **N2 matched a bare `toggleProvenance` identifier.** With the entire provenance section
  deleted, N2 still passed — the destructure at the top of the component was enough. It now
  requires the callback to be *bound to a control*, which is what "a reachable control opens
  the panel" actually means.
- **N1's filters leg matched `classes.filter(Boolean)`.** A bare `/filter/i` scored the
  filters stage as present against a column that had never had one. It now requires a filter
  control — a toggle the operator can press whose state the column reads back.

N3 additionally has the rendered confirmation its own header asked for. The declared-height
probe cannot see specificity; `docs/mockups/webkit-probe-narrow-targets.js` measures
`getBoundingClientRect().height` in WebKit against the **built** CSS bundle at 375 px:

```
iframe viewport = 375px · narrow rules apply: true
PASS  composer Run (.btn.btn-primary) rendered 44.0px      PASS  theme toggle (.iconbtn) rendered 44.0px
PASS  composer Stop (.btn) rendered 44.0px                 PASS  Open full provenance (.btn) rendered 44.0px
PASS  run history (.iconbtn) rendered 44.0px               PASS  popover Retry (.pop-inline .btn) rendered 44.0px
PASS  mode chip (.mode-chip) rendered 44.0px               PASS  filter chip (.filter-chip) rendered 44.0px
PASS  summary row (.prov-sum) rendered 44.0px
```

Against the same bundle with the four narrow rules reverted, those rows read 28 / 32 / 24 /
42 px — the probe can produce its own failure, which is the only thing that makes it evidence.
Two constraints shaped it and both are load-bearing: `verify-webkit.swift`'s window is
1600 px, so the measurement happens inside a 375 px iframe; and a `file://` iframe is
cross-origin in WebKit, so the fixture is written into `about:blank` to stay same-origin.

`ui/src/components/run/RunColumn.test.tsx` covers what neither probe can see, since both are
static: the coverage sentence built through the real `projectRun`, §11.6's source order, the
provenance route firing, the capture word on the card face, the filter narrowing the evidence
while the summaries hold the projector's counts, and the emptied-by-filter message.

### 9.3 Deliberately not counted as defects

- **No whole-stage scaling.** Failure 21's first clause is met: the narrow branch swaps the
  coordinate canvas for a source-ordered scrolling `.run-column`, rather than shrinking the
  1600 × 1000 stage with a transform. This is the part §11.6 cared most about and it is
  right.
- **Theme switching was never hidden.** Failure 21's last clause was always met — the theme
  toggle is present and reachable at this width. It was merely undersized, counted once
  under N3 rather than twice.
- **The composer is not clipped.** It reflows (`flex-wrap`, the input taking its own row)
  and stays viewport-docked; only `.comp-note`, a hint line and not an action, is hidden.
- **Failures 19 and 20 are §6's**, not this section's, and TNG-158 closed them.

### 9.4 Owner — TNG-173, and why it was one issue and not four

All four contracts were owned by **TNG-173**, filed as a child of TNG-90 so that closing the
parent could not quietly orphan them, and explicitly *not* blocking it. Closed 2026-09-11.

N1, N2 and N4 were one defect seen from three sides: the provenance layer had no narrow
route. Giving the column a way in closed N2; the stages N1 wanted and the capture quality N4
wanted then became placeable, each still needing its own placement decision. N3 was
independent — a stylesheet gap touching none of the others. They were filed together because
splitting them would have handed three agents the same first edit, and that held: one section
and one narrow CSS block closed three of the four.

Scope: **implementation only**, as filed. The prototype is not implicated and was not
touched — §11.6 was authored from it, and `#compose`/`#running`/`#answered`/`#trace`/
`#unanswered` were never what failed here. TNG-90's Gate B governs the design, not this
implementation, and was never blocked by this section.

### 9.5 The prototype side, now measured rather than assumed — PASS 15/15

§9.4's "the prototype is not implicated" was the right call, but until now it was an
*inference*: §11.6 was authored from the prototype, so the prototype was presumed to satisfy
it. Nothing had measured that. Every §11.6 instrument reads production — the N1–N4 gate reads
`RunColumn.tsx` and the app stylesheets, and `webkit-probe-narrow-targets.js` measures the
built `ui/` bundle. The artifact **Gate B actually pins** had never been opened below 768 px.

That gap mattered more than a normal untested claim, because §11.6 is written as a statement
about the prototype ("Below 768 px *the prototype* stops fitting the entire 1600 × 1000 stage
with a transform"). A board approving the prototype on the strength of §9 would have been
reading a green count earned entirely by a different artifact.

It now holds on both sides. `webkit-probe-prototype-narrow.js` drives the pinned standalone
at 375 px in WebKit — the engine the board reviews in — and reads **15/15**:

- **T1** the measuring conditions: the narrow media query matches, and `transform: none` is in
  force so the stage's ~0.92× design scale cannot skew a 44 px reading into a 40.6 px "defect".
- **T2** failure 21: **0 of 48** visible core actions across `#compose #running #answered
  #trace` render below 44 px. The prototype's narrow block lifts `.btn`, `.iconbtn`, `.filt`
  and `.seg button` together — which is the rule production was missing, not one it broke.
- **T3** failure 21: theme switching is reachable *and* switches (`dark → light`).
- **T4** failure 21: the composer is not clipped, and the column has no horizontal overflow.
- **T5** failure 22: provenance survives — 8 visible provenance elements, 11 expanders, and
  one-hop expansion verified on both an evidence entity and an agent node.

**Proven in both directions.** `--defeat targets|provenance|theme` re-injects the pre-fix
shape of each contract, and each defeat fails the checks that own it: `targets` reads the
mode chip, Save & run, Run history and the theme toggle back at 28 px — the exact production
defect N3 found; `provenance` empties the narrow column; `theme` hides the toggle.

**Two false readings this probe produced before it was trustworthy**, both recorded because
the next person to touch it will hit them:

- Its first draft looked for `.ent` and `.ent [aria-expanded]`. The narrow column renders
  `.activity-ent`, a different class token, and those entities *are* the expanders rather than
  containing one. It reported "0 visible expanders" against a prototype with eleven.
- Activating a node repaints `#overlay` wholesale, so the clicked element is detached
  (`isConnected === false`) and keeps its pre-click attributes forever. Read through the held
  reference, the one-hop check reported `false → false` on an expansion that worked. It
  re-queries after the click now, and prints the detached flag so the trap stays visible.

Both were false *negatives* — they would have sent the board a defect that did not exist.
The denominator guard (T2a) is the matching protection in the other direction: under the
`provenance` defeat, T2b alone still read "0/17 undersized" and only T2a's floor caught that
the probe had lost two-thirds of its specimens.

## 10. The prompt composer — PASS, 14/14 (closed 2026-09-12; audited as 5/13 the same day)

> **Status, 2026-09-12 08:15 SGT.** All eight open contracts are closed and the gate reads
> **14/14** — C1–C9 client-side and C9-B, the daemon half added with the field (TNG-193,
> TNG-194, TNG-195). The subsections below are kept in the past tense they were written in:
> they are the record of what was wrong, which is what makes the fix reviewable. §10.6 is the
> part that matters now — it is the audit that the 14/14 is real, and it found and closed two
> rows that were passing for the wrong reason.
>
> Verified this heartbeat, against the tree at 08:14 SGT:
> `node docs/mockups/verify-composer-conformance.mjs` → 14/14 ·
> `python3 docs/mockups/defeat-composer-conformance.py` → every row individually defeatable ·
> `ui/` 173 tests in 26 files pass · `tsc -b` clean · the three new daemon tests
> (`expected_revision_conflict_returns_a_stable_code_and_creates_no_run`,
> `start_keys_collapse_duplicates_and_bind_to_the_exact_request_fingerprint`,
> `a_start_key_can_be_recovered_by_get`) pass. The three `runs::` tests that fail need
> `DATABASE_URL` and fail identically before this change — environment, not code.

§1 of the interaction spec is the surface every run starts at, and it was the **last layer
never checked against an implementation** — §§6–9 each took an acceptance clause; this one
took the section the spec opens with. `node docs/mockups/verify-composer-conformance.mjs`
reads production source under the same discipline as §§6–9: every rule anchored to a line a
reviewer can open, `exit 2` if a selector drifts, so a lost anchor can never read as a real
failure. **As audited it read 5/13**; it reads 14/14 as of `e264610` and TNG-194.

Three of the eight it found were ordinary geometry and wording. Five were not: they were the
clauses §1 spends its prose defending — the two-step legibility of `Save & run`, one start
key per attempt, and the revision the run actually executes.

### 10.1 The eight contracts that were open

- **C1 — `⌘↵` does not submit from anywhere. §1.2.** The spec's first keyboard row reads
  *"submit — from anywhere in the app, including a focused canvas."* The only binding is on
  the composer's own `textarea` (`Composer.tsx:57`). Worse than absent: the global handler's
  `Enter` branch (`Workspace.tsx:779`) never tests the modifier, so `⌘↵` **on a focused
  canvas with an agent selected dispatches `loomwatch:rename-agent`** — the app answers the
  submit shortcut by offering to rename something. The command palette advertises `⌘↵` for
  *"Run the team…"* and only focuses the field (`:698`).
- **C2 — `Esc` does not collapse the composer. §1.2.** *"blur and collapse to one line, text
  preserved."* The height is written by an effect keyed on `[value]` alone
  (`Composer.tsx:46–51`), so nothing recomputes it on blur. Text is preserved — correct —
  but a grown composer stays grown, keeping the canvas occluded after the operator has
  explicitly dismissed it.
- **C3 — the input grows to six lines, not five. §1.1.** `max-height: 120px` against the
  rule's own `14px/20px` (`runtime.css:27–31`), matched by `Math.min(120, …)`. The approved
  value is 5 lines = 100 px. The gate derives `5 × line-height` from the same rule rather
  than hard-coding 100, so a type-scale change cannot turn this green by accident.
- **C4 / C5 — the pipeline-terminal blocker identifies nothing. §1.3.** One spec row, two
  promises, each independently fixable, so each is its own check. The approved line names the
  offenders — *"This one has two: `author`, `qa`"* — and `[ Show on canvas ]` **selects
  both**. Shipped: *"A pipeline needs exactly one final agent — 2 found."*, and the action is
  `flow.fitView` (`Workspace.tsx:688`), which frames the whole canvas and selects nothing. On
  a team of twenty the operator is told a count and handed a route that identifies the two
  offending agents no better than the count did.
- **C6 — a clean document reports a save that never happens. §1.4/§1.6.** `starting` (the
  run-creation flag) and `pendingPrompt` (the save flag) both return `{ kind: 'saving' }`
  (`Workspace.tsx:684`). So starting a run on a **clean** file puts *"Saving
  research-team.yaml — the run is created against the revision this write returns."* under
  the button while no write is occurring, and §1.6's `Starting…` is unreachable. §1.4 asks
  for these two labels by name and says why: *"so the two steps stay legible as two steps."*
  The implementation collapses them into the one that is false.
- **C7 — there is no start key. §1.6.** *"`⌘↵` generates one start key and holds it for the
  life of the attempt… A connection loss during submit **never** retries blind: the client
  re-`GET`s by start key."* `startRun` posts `{ teamPath, prompt }` (`runs/client.ts:86–95`)
  — no key in body or headers. The in-flight guard is real but is state, not identity: on a
  thrown fetch `launch`'s `catch` sets an error and leaves the prompt in the field with `Run`
  enabled, so **the operator's natural re-press is exactly the blind retry this clause
  forbids**, and the daemon has no key to collapse the duplicate against.
- **C9 — nothing pins the bytes the run executes. §1.4/§1.5.** §1.4 specifies the pair:
  conditional `PUT` (which ships — C8 passes), *"then `POST /api/runs` with
  `expectedRevision` = the revision the PUT returned."* The daemon half now ships (TNG-194):
  `StartRunRequest` accepts an optional `expectedRevision`, `prepare_run()` compares it
  against the SHA-256 of the current file bytes, and a mismatch answers `409` with a stable
  `stale_team_revision` code and the authorized `currentTeamRevision`, creating no run
  (`runs.rs:519`, `runs.rs:752–755`, `runs.rs:589–595`). The gate asserts this as row C9-B.
  A disk write landing between the save and the start is now refused instead of executed
  silently, giving §1.5's *"No run is created"* its enforcement point — the case §1.4 opens
  by naming: *"The operator must never be able to think they ran what is on screen when they
  ran what is on disk."*

### 10.2 The five that pass, and why they are in the gate

A gate whose every row is red cannot show that its selectors still bind, and three of these
guard rules that a plausible fix to a red row would break.

- **C8** — the `PUT` half of `Save & run` is conditional (`If-Match`). C9's fix must not
  regress it.
- **C10** — *the narrow block keeps the composer.* §1.1's own table says *"Below 768 |
  composer hidden"*, and that row is **superseded** by §11.6, whose acceptance failure 22
  reads *"Narrow mode loses submission… **Fail.**"* Hiding the composer below 768 px would
  satisfy the older row by failing the newer one. The supersession is encoded here so it is
  enforced rather than recalled — this is the row a future reading of §1.1 is most likely to
  "fix" backwards.
- **C11** — §1.7: no model picker, temperature, agent selector or attachments have appeared
  in the composer.
- **C12** — §1.4's *"no 'run without saving'"*: `submit()` saves a dirty document and starts
  nothing if the save fails.
- **C13** — §1.5's *"the prompt is held until the run id comes back."* The clear happens only
  after `startRun` resolves. §1.5 calls losing a typed goal *unforgivable*; C13 is the row
  that would catch it.

### 10.3 Sequencing, and who owns this

§1 is design-layer work on an implementation that already shipped, exactly like §§6–9. It
reads only production source and adds **no bytes to the pinned prototype**, so §5 still
holds and the pending Gate B card is unaffected — the hash is unchanged by this section.

The owner was to be the **Web UI Engineer**, who is in `error` (`opencode_local` out of
OpenRouter credits, last heartbeat 2026-09-11T16:28Z) — the fleet-funding problem already in
front of the board on TNG-136/TNG-98. In the event the work did not wait for that, and it was
split the way §10.3 proposed:

- **The client half — C1–C7 and C9's caller — by the Product/UX Designer on TNG-193**, commit
  `e264610`. `Workspace.tsx`, `composer/Composer.tsx`, `runs/client.ts`, `useTeamDocument.ts`
  and `runtime.css`, with four new `Workspace.test.tsx` cases asserting C1, C6, C7 and C9
  behaviourally — a source grep cannot see a shortcut fire or a start key survive a dropped
  response, and §10.6 is why that distinction is not taken on trust.
- **The daemon half — C9-B — by the Rust Systems Engineer on TNG-194/TNG-195**: the
  `expectedRevision` field, the `stale_team_revision` conflict, and start-key collapsing, plus
  the gate row and `defeat-composer-conformance.py` that audits all fourteen.

Both landed on 2026-09-12, concurrently, in the same workspace. That is what §10.3 meant by
*the contracts will still be true whenever an owner can act* — they were written so that any
funded owner could pick them up, and two did.

### 10.4 What this section deliberately does not file

- **The entrypoint preflight row.** §1.3 lists *"team mode, no entrypoint"* as its own
  blocker with its own line. The implementation folds it into the generic problems branch —
  `entrypointProblem` is the first entry `reviewProblems` returns (`problems.ts:49`), so an
  entry-point-less team *is* blocked, with `[ Review ]` naming it in the popover. Different
  route, same guarantee, and consolidating two blockers onto one surface is a design call the
  spec does not forbid. Not a defect.
- **The `⌘⇧↵` label.** §1.2 and §1.4 give `Save & run` the shortcut `⌘⇧↵`; the button renders
  `⌘↵`. Both key combinations already submit (`event.key === 'Enter'` is unchanged by
  `shiftKey`), so this is a label that under-promises, not a broken binding — too small to
  spend an owner's turn on while C1–C9 are open.

### 10.5 The gate's own audit, before the fixes landed

`python3 docs/mockups/mutate-composer-conformance.py` proved every row detectable **in both
directions**: apply all eight fixes → 13/13; revert each one → exactly the owning row turns
red; defeat each of the five that pass today → exactly that row turns red. 13/13 detectable.
This is §7.5's discipline applied at authoring time rather than after a false green: §7.5
found two checks (B3, B5) that could not fail, and §9 later found a D5 in the same state.
`ui/` is never written — the harness mutates a scratch copy only.

That harness is **spent**. Its patches apply the eight fixes, and the fixes have landed, so
its anchors are gone and it now answers `CANNOT RUN`. That is the right answer to a question
that is no longer open; §10.6 asks the one that is.

### 10.6 The gate's audit after it went green

A gate that has just gone green is the *least* trustworthy moment to read it: every row
agrees with the tree, so nothing distinguishes a row that is satisfied from a row that cannot
fail. `python3 docs/mockups/defeat-composer-conformance.py` runs the surviving direction —
restore each recorded defect one at a time in a scratch copy, and require the failing set to
grow by **exactly** that row. It takes its row list from the gate's own output, so a row added
to the gate without a defeat here is reported rather than silently skipped.

Run against the freshly-green tree it found **three rows that survived their own defect**:

| Row | Why it could not fail | Fix |
|---|---|---|
| **C2** | The second leg read `/Escape/` against the composer's key handler — the claim that Escape is *handled*, not that it collapses anything. Deleting the focus-keyed height effect left the row green on an `Escape` branch that only blurs, which is the defect C2 records, verbatim. | Both legs now have to reach the height: `/Escape[\s\S]{0,200}style\.height/`. |
| **C9** | `expectedRevision` was matched anywhere in `startRun()` + `submit()`. With the field stripped from the request body, the destructure and the `launch` call, the row stayed green on the **comment** above the call — the sentence explaining the contract. | Inputs are read comment-stripped. |
| **C12** | `/if \(!saved\)[\s\S]{0,120}return/` matched the word *"returned"* in a comment two lines below a broken guard. | Inputs are read comment-stripped. |

C9 and C12 are the same failure in two places, and it is the one this ledger has hit before
(§7.5's B3, §9's D5): **a check that matches its own prose**. The rule now is that every input
is read with comments stripped, so what the gate matches is what the program does. Whole-line
`//` only — a trailing comment needs a tokenizer to remove safely (`"https://…"` appears
mid-line in the Rust input), and no contract here is expressible in one.

After both fixes: 14/14 green, and all 14 individually defeatable. `ui/` and `crates/` are
never written — the harness mutates a scratch copy only.

## 11. Short viewport, height < 600 px — PASS, 5/5 static and 16/16 rendered (TNG-201, TNG-203)

The §13 record lived only in an issue document until now. That is the gap this section closes:
an issue document is not in the checkout a reviewer opens, and **its four gate files were never
committed**, so the evidence certifying the fix did not exist on `main` while the other seven
gate suites did. They are tracked as of this section. Nothing in them touches `ui/`.

### 11.1 What went wrong

`TNG89_INTERACTION` §13 authorises **clustering chrome** below 600 px of height. What shipped
instead set `display: none` on `.comp-mid` and `.comp-act` — which hold, respectively, the
prompt `textarea` (`Composer.tsx:126`) and the primary run action plus run history
(`Composer.tsx:141`). Below 600 px the composer collapsed to a bare mode chip: **no way to type
a goal, no way to submit.** It also hid `.mode-pop` while `.mode-chip` (`Composer.tsx:121`) kept
advertising `aria-haspopup="dialog"` — a dead affordance with ARIA still claiming the state,
the TNG-131 class.

The misreading is worth recording because it was reasonable: §13 predates §9 delta 1, which
moved the mode pill *into* the composer, so "merge the pill" silently became "delete the input."
§11.6's failures 21 and 22 already score losing the composer or its submission as a Fail in the
**width** direction; height is the same contract, and nothing said so.

### 11.2 The fix, and the premise it had to disprove

`ui/src/styles/runtime.css:222`. Prompt and action are kept and the band is shortened —
`min-height` 56 → 44 px, `textarea` `max-height` 100 → 40 px (§1.1's five lines relaxed to two
at this height, still scrolling). `.comp-note` stays visible: it carries the `role="alert"`
preflight blocker (§6.3). `.lib-open .lw-viewctl` is pulled back into the composer's band,
overriding the 768–1179 rule that would stack it as a second 68 px band — that is the actual
§13 merge. Popovers are viewport-capped with `overflow: auto` rather than hidden.

The hidden rule rested on *"it cannot fit."* Bounded, it fits at any height. The one thing the
fix deliberately does **not** do is re-tighten the popover anchor to `inset + 52px` to buy those
pixels: the composer band is ~57 px, not 44 px, whenever `.comp-note` carries the preflight
blocker, and the tightened anchor opened the popovers *through* their own composer — measured at
5 px of overlap. R9 is the contract that holds that line.

### 11.3 Why the gate is two gates

The original gap was found by a static grep, and **a static grep is also what scored the
regression as fixed.** So the section is measured twice:

| Gate | Reads | Result |
|---|---|---|
| `verify-short-viewport.mjs` — H1–H5 | `runtime.css` · `Composer.tsx` source | **5/5** |
| `webkit-probe-short-viewport.js` — R0–R9 | the **built bundle** in WebKit, 5 frames | **16/16 `ok`, 0 `FAIL`** |
| `defeat-short-viewport.mjs` | mutates a scratch copy of the built CSS | **8/8 mutations reddened** |

H1–H5 assert that the rule exists, the prompt survives, the action survives, no control
advertises a hidden popover, and the view controls actually merge. The gate strips CSS comments
before matching, so its own prose cannot satisfy a probe — §10.6's C9/C12 failure.

R0 is the frame check that makes the rest falsifiable: the probe renders a **599/601 pair** that
straddles the boundary, so every rendered claim has a rule-off counterfactual beside it. R5 and
R2 exist because `display: none` is not the only way to lose a control — a composer pushed
off-viewport by `bottom`, or an action faded to `opacity: 0`, is invisible to the grep that H2
and H3 run. R8 measures the **short AND narrow** intersection (667x375), where §11.6's 44 px
target rule and §13's shortened band are in tension: it reads 44.0 px.

### 11.4 The counterfactual pass

Eight mutations, each appended to the built bundle so a later rule of equal specificity wins the
cascade — `ui/` and the pinned artifact are never written:

| Mutation | Contracts that reddened |
|---|---|
| TNG-201 verbatim — hide `.comp-mid` and `.comp-act` | R1, R2, R3 |
| TNG-201 verbatim — hide the popovers under a chip that still advertises them | R4, R6 |
| uncap the mode popover (the *"it cannot fit"* premise) | R6 |
| re-tighten the popover anchor to `inset + 52px` | R9 |
| un-merge the view controls back into a stacked band | R7 |
| push the composer off-viewport by `bottom` | R5 |
| fade the run action to `opacity: 0` | R2 |
| undercut the 44 px target at the short **and** narrow intersection | R8 |

The last three are the ones a static gate cannot reach at all. Reverting each fix individually
in `runtime.css` produced the matching H-row FAIL, and deleting the block failed all five;
`runtime.css` was restored byte-identical each time.

### 11.5 What a clean checkout of `main` reports

`ui/src/styles/runtime.css` is **untracked** — TNG-198's revert state, production UI held out of
`main` ahead of Gate B. Run from a pin extraction or a clean `main` checkout,
`verify-short-viewport.mjs` therefore exits **2**, naming `Composer.tsx` as the absent input and
saying in its own output that this is *not* a conformance failure — the §6–§9 convention, and
the reason this gate was written to it from the start. Exit 2 is never a verdict.

`main`'s tracked `ui/src/index.css` carries its own `@media (max-height: 599px)` block, but it
addresses `.react-flow__controls` and `.canvas-mode-control` — **selectors of the pre-rebuild
UI that the shipped workspace no longer renders.** TNG-201's defective rule never reached
`main`, and nothing here asks for it to be reverted there.

## How to reproduce

```sh
# §1 and §2 — per-theme token diff, then the non-token primitives diff.
# Exits non-zero on any missing token, value drift, or unexpected extra.
# Run it from a full checkout: it reads ui/src/styles/tokens.css, which is production
# source and is NOT inside the docs/ tree a Gate B pin extracts. Against an extracted pin
# it exits 2 and says it cannot run — that is not a drift failure and not a finding
# against the artifact. (Gate B's evidence table lists this row under "re-run against the
# pinned bytes"; it is the one row that measures the implementation instead.)
python3 docs/mockups/verify-token-conformance.py

# §1.4 — and the audit of THAT gate, the one with the worst record here: it read PASS for two
# days through a dropped primitive (§1.1), its repair left it unable to fail on one at all
# (§1.3), and the prose counterfactual meant to catch that shipped with a row scored wrong
# (§1.2). Eight defects, each of which must redden exactly the check that owns it AND print
# the line naming it, plus the allowlist seam and the exit-2 refusal path. Exit 0 = the gate
# can be made to fail on everything it claims to catch. Scratch copy only; `ui/` is never
# written, and neither is the gate — it is staged beside staged inputs rather than edited.
python3 docs/mockups/defeat-token-conformance.py

# §1.1 — the WebKit half of the `-webkit-backdrop-filter` finding. The claim there is a
# measurement, not a compatibility table: it says this engine honours the unprefixed
# property, which is why the restored line is parity for older WebKit rather than a fix
# for a defect the board can see. Reproduce it on any page carrying `.e1` — a rule with
# only `backdrop-filter` set must compute non-`none` for BOTH properties below.
swift docs/mockups/verify-webkit.swift docs/mockups/prototype-standalone.html --eval /dev/stdin <<'JS'
(() => {
  const el = document.querySelector('.e1');
  if (!el) return 'FAIL no .e1 on this page — cannot answer';
  const cs = getComputedStyle(el);
  return [
    'engine            = ' + navigator.userAgent.match(/AppleWebKit\/[\d.]+/),
    'supports unprefixed = ' + CSS.supports('backdrop-filter', 'blur(20px)'),
    'backdropFilter       = ' + cs.backdropFilter,
    'webkitBackdropFilter = ' + cs.webkitBackdropFilter,
  ].join('\n');
})()
JS

# §3 — reduced-motion coverage
grep -rn 'infinite' ui/src/styles/*.css
for f in ui/src/styles/*.css; do awk '/prefers-reduced-motion/,/^\}/' "$f"; done

# §4 — vocabulary
grep -n 'EntityKind =' ui/src/components/ui/glyphs.tsx
grep -n 'EvidenceKind =' ui/src/lib/watch/events.ts
sed -n '9,16p' ui/src/components/run/ProvenancePanel.tsx

# §5 — the artifact matches the commit the CURRENT Gate B card pins.
# It no longer matches 83b4a49: §8 added the #unanswered screen. Both lines must agree,
# and the right-hand commit is whichever one the pending card names.
shasum -a 256 docs/mockups/prototype-standalone.html
git show HEAD:docs/mockups/prototype-standalone.html | shasum -a 256
# and the standalone is a build product — it must rebuild to the same bytes
node docs/mockups/build-standalone.mjs && shasum -a 256 docs/mockups/prototype-standalone.html

# §6–§9 are IMPLEMENTATION gates: like the token gate above, they read `ui/` and are not
# part of the docs/ tree a Gate B pin extracts. Run them from a full checkout. Against an
# extracted pin each now exits 2 naming the absent input, rather than raising ENOENT — a
# traceback on a card asking for approval is indistinguishable from a finding against the
# artifact, and all four used to produce one. Exit 2 = cannot answer; it is never a verdict.

# §6 — accessibility contracts. Exits 1 while any of A1–A5 is open, 0 when all are closed,
# and 2 if the gate cannot answer (a drifted selector, or an absent ui/ input).
node docs/mockups/verify-a11y-conformance.mjs

# §7 — evidence-quality contracts. Same exit convention, B1–B5.
node docs/mockups/verify-evidence-honesty.mjs

# §7.5 — and the audit of that gate itself: defeat each contract one at a time and require
# the owning check to turn FAIL. A check that has never failed is not evidence; this found
# two (B3, B5) that could not. Exit 0 = every contract detectable, 1 = a check cannot fail,
# 2 = the harness could not run. It mutates only a scratch copy; `ui/` is never written.
python3 docs/mockups/mutate-evidence-honesty.py

# §8 — response-node contracts. Same exit convention, D1–D6.
node docs/mockups/verify-response-states.mjs

# §9 — narrow/responsive contracts below 768 px. Same exit convention, N1–N4.
# Exits 0 (4/4) since TNG-173. See §9.4 for the owning issue.
node docs/mockups/verify-narrow-conformance.mjs

# §9.2 — N3's rendered confirmation, the one the declared-height probe cannot give.
# Measures the BUILT bundle in WebKit at 375 px, so a 44 px rule that loses the
# cascade to a more specific one is caught even while N3 passes.
(cd ui && npm run build)
node docs/mockups/build-narrow-fixture.mjs
swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
/tmp/verify-webkit /tmp/loomwatch-narrow/host.html \
  --eval-async docs/mockups/webkit-probe-narrow-targets.js

# §9 behaviour — what both probes are static for: the route firing, the filter
# narrowing evidence while the summaries hold the projector's counts.
(cd ui && npx vitest run src/components/run/RunColumn.test.tsx)

# §10 — prompt-composer contracts, §1.1–§1.7 as revised by §11.6. Same exit convention,
# C1–C13 plus C9-B, the daemon half. 14/14 since e264610 (client) and TNG-194 (daemon).
node docs/mockups/verify-composer-conformance.mjs

# §10.6 — and the audit of THAT gate now that its rows are green: defeat each of the
# fourteen in turn and require exactly that row to redden. Exit 0 = every row can fail on
# its own. It found three rows passing for the wrong reason. Scratch copy only.
python3 docs/mockups/defeat-composer-conformance.py

# §10.5 — the same audit from the other side, run while the rows were still open: apply all
# eight fixes (13/13), revert each one, then defeat each of the five that passed. Its patch
# anchors are gone now that the fixes have landed, so it answers SUPERSEDED (exit 2) and
# points here — kept as the record of how the rows were proven detectable BEFORE they were
# ever green, which is the half of the discipline a post-hoc audit cannot reconstruct.
python3 docs/mockups/mutate-composer-conformance.py

# §9.5 — the same §11.6 contracts against the PROTOTYPE, the artifact Gate B pins.
# Needs no ui/ build: it reads the pinned standalone and prints its sha256, so the
# bytes measured can be checked against the bytes the card names. 15/15.
swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
F=$(node docs/mockups/build-prototype-narrow-fixture.mjs | awk '/^fixture:/{print $2}')
/tmp/verify-webkit "$F" --eval-async docs/mockups/webkit-probe-prototype-narrow.js

# ...and the counterfactual: each defeat MUST fail the checks that own it.
for d in targets provenance theme; do
  F=$(node docs/mockups/build-prototype-narrow-fixture.mjs --defeat $d | awk '/^fixture:/{print $2}')
  /tmp/verify-webkit "$F" --eval-async docs/mockups/webkit-probe-prototype-narrow.js
done

# §11 — short-viewport contracts, height < 600 px. Same exit convention, H1–H5.
# Static half: source-level, no build needed.
node docs/mockups/verify-short-viewport.mjs

# §11.3 — the rendered half, which is the half that matters: `display: none` is not the
# only way to lose a control, and the grep above cannot see a composer pushed off-viewport
# or an action faded to opacity 0. Renders a 599/601 pair so every claim has a rule-off
# counterfactual beside it. 16 ok, 0 FAIL.
(cd ui && npm run build)
node docs/mockups/build-short-viewport-fixture.mjs      # writes /tmp/loomwatch-short/host.html
swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
/tmp/verify-webkit /tmp/loomwatch-short/host.html \
  --eval-async docs/mockups/webkit-probe-short-viewport.js

# §11.4 — and the counterfactual, starting from TNG-201's rule verbatim. Exit 0 = every
# mutation produced the failure the probe promises (8/8). Mutations are APPENDED to a
# scratch copy of the built CSS, so `ui/` and the pinned artifact are never written.
VERIFY_WEBKIT=/tmp/verify-webkit node docs/mockups/defeat-short-viewport.mjs

# §7.1 — the three channels §5.1 requires, counted in production
grep -c 'cap-' ui/src/styles/*.css          # 0 0 0 — no border treatment ships (TNG-89F's)
grep -n 'Capture =' ui/src/lib/watch/events.ts # §8.1's four values, admitted by the type;
                                               # the projector emits `recorded` (TNG-170)

# §7.2 — coverage for agents is the headcount under another name
sed -n '525,532p' ui/src/lib/watch/events.ts
```

Every gate here asserts contracts rather than today's state, so a gate that goes green is
the signal that its section can be struck — not a signal that the probe drifted. Each check
was also confirmed in the other direction: applying the minimal shape of its fix flips it to
`PASS`, so none of them is stuck-at-fail.
