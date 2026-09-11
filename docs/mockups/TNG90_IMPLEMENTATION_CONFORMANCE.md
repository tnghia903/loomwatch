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
  **Not conformant on the honesty layer** (§7) — five contracts were unmet; three closed
  within the hour and a fourth since, leaving the entity-level `capture` seam (B1) open and
  now owned by its own issue `2b9a0e34` (§7.2). **Not conformant on the response layer**
  (§8) — six §3.3–3.4 contracts were unmet, all six closed by TNG-166.
- **B1 is the one conformance defect still open.** All three TNG-90 children are done and
  `verify-evidence-honesty.mjs` still exits `1`; it does not block Gate B, which governs the
  design (§5), not this implementation.
- **Three sections are historical.** §6, §7 and §8 record contracts and reasoning, and
  their verdicts are the state at the moment of observation. `verify-a11y-conformance.mjs`
  (`5/5`), `verify-evidence-honesty.mjs` (`4/5`, B1 open) and
  `verify-response-states.mjs` (`6/6`) are the current answer.

This checks the implementation's *claims* against the approved design. It does not review
code quality, and it does not touch the Gate B artifact — see §5.

**Revision history.** §§1–5 were written 2026-09-11 and published at commit `818dbef`; §6 was
added the same day, after the token pass, when the interaction layer — a TNG-89A acceptance
criterion that had never been checked against an implementation — was audited. §7 followed,
covering the one remaining layer TNG-89A puts an acceptance criterion on: evidence quality.
§§6–7 read only production source and add no bytes to the pinned prototype; §5 still holds.
§8 was audited by the same probe discipline at `72c0ca4` — six §3.4 contracts on the
response node, all open — and closed the same day by TNG-166; its backend half (the daemon
emitting the code the strip now carries) is TNG-168's.

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

## 7. Evidence quality — FAIL as audited; four of five closed, B1 open and re-owned

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
> rather than patching the two counts. B3 has since closed as well, leaving exactly B1 — run
> the gate for the number; this note deliberately no longer carries one, having been wrong
> twice. Anything here that reads as a verdict is the state at the moment it was observed;
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
field only**; the border and glyph channels stay `TNG-89F`'s.

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

### 8.2 Deliberately not counted as defects

- **`partial` still consults `crash?.message`.** The archived crash event's payload
  message is the daemon's own words, verbatim — exactly what the slot is for. Only the
  *manufactured* fallbacks were removed.
- **`exit N` remains a watermark when the daemon reports no code** for a genuinely failed
  run. `exit 137` is a machine fact that names itself; it is not an invented code.
- **The cancelled strip keeps its prose.** "Cancelled by the operator. Partial answer
  kept." reflects the operator's own action back at them; it is not a daemon error being
  paraphrased.

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

# §6 — accessibility contracts. Exits 1 while any of A1–A5 is open, 0 when all are closed,
# and 2 if a selector has drifted (so a lost anchor can never read as a real failure).
node docs/mockups/verify-a11y-conformance.mjs

# §7 — evidence-quality contracts. Same exit convention, B1–B5.
node docs/mockups/verify-evidence-honesty.mjs

# §8 — response-node contracts. Same exit convention, D1–D6.
node docs/mockups/verify-response-states.mjs

# §7.1 — the three channels §5.1 requires, counted in production
grep -c 'cap-' ui/src/styles/*.css          # 0 0 0 — no border treatment ships
grep -n 'capture' ui/src/lib/watch/events.ts # no field on interface Evidence

# §7.2 — coverage for agents is the headcount under another name
sed -n '525,532p' ui/src/lib/watch/events.ts
```

Both gates assert contracts rather than today's state, so a run that reports `5/5` is the
signal that the section can be struck — not a signal that the probe drifted. Each check was
also confirmed in the other direction: applying the minimal shape of its fix flips it to
`PASS`, so none of the ten is stuck-at-fail.
