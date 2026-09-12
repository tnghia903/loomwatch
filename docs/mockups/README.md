# LoomWatch — TNG-87 design artifacts

## TNG-124 revision — capability library polish and reachability fix

The board rejected the TNG-122/123 candidate a second time: "recheck the library UI, I
don't feel it is aesthetic enough. Also, I cannot drag and drop everything in the library
sidebar." Both complaints traced to the same panel, and both had a concrete, measured cause
— this was not a subjective repaint.

**Root cause 1 — rows overflowed their own box.** `.lib-row` was a fixed `height: 40px`,
sized for the original two-line palette row (name + path). TNG-122/123 added a third line
— `.lib-row-meta`, the state/wired badges — without widening the box: measured in headless
Chrome, the three-line stack needs **49.5 px** inside a **36.96 px** rendered row with only a
**6 px** gap to the next row. Every capability row was quietly bleeding into the row below it.
That is what read as "not aesthetic": the library was never intentionally styled at this
density, it was clipping. Fixed by giving `#library .lib-row` (scoped there, not the shared
`.lib-row` class the TNG-121 Available-team palette also uses — that panel's two-line rows
already fit 40 px and stay unchanged) a `min-height: 44px` card with real vertical padding.

**Root cause 2 — the scroll affordance was invisible, not broken.** The catalogue is up to
20 resources across 4 groups; the panel physically fits roughly 8 rows. `.lib-scroll` already
had `overflow-y: auto` and *every* row — agent, skill, tool, knowledge — was already
draggable in the underlying code (verified directly: real native HTML5 drag simulated via
Chrome DevTools Protocol `Input.dispatchDragEvent`, not a synthetic in-page `DragEvent`,
successfully placed a skill, two tools, two knowledge sources and an agent onto the canvas
once each row was scrolled into view). The failure was discoverability: macOS's overlay
scrollbar is invisible at rest, so a reviewer who never scrolled saw a shorter list than
exists and reasonably concluded the rest "can't be dragged." Fixed with a persistent thin
scrollbar thumb (`scrollbar-color` + `::-webkit-scrollbar`) and a real, scroll-position-driven
edge fade (`.can-scroll-up` / `.can-scroll-down`, toggled on scroll/resize/render by
`updateLibScrollFade()` — never a static decoration, so it never lies about a fully-visible
list). Confirmed still true from a cold load: even with **Tools & connectors** collapsed (its
default state), `scrollHeight` (1455) already exceeds `clientHeight` (614) — the affordance
gap existed before any group was ever expanded.

**Aesthetic pass, same panel.** Rows are now bordered cards (`border: 1px solid
var(--color-hairline)`, tinted background) instead of borderless text sitting on the ground;
resource monograms are circular (`.monogram.res`) against agents' square monograms, so kind
is legible by shape before you read the label; group headers gained a pill-style count and a
hairline divider between sections; a `.lib-row.dragging` state (opacity + dashed border) marks
the row actually in flight during a drag, distinct from `:hover`. Filter chips, search field,
and the footer status line are unchanged in structure — only the row/group scaffolding around
them was under-built.

Nothing here changes backend or schema assumptions — `TNG89_INTERACTION.md §14.7` and
`TNG122_FREEFORM_CAPABILITY_COMPOSER.md` stand as written. This is a CSS/JS visual and
interaction fix inside the existing capability-library data model and wiring rules; no new
node type, edge type, or endpoint is introduced. Self-check: `docs/mockups/TNG124_SELF_CHECK.md`.

## TNG-122 revision — freeform capability composer

Open **Freeform wiring** in `prototype-standalone.html`. The fixed insertion lane is no
longer the editing model: authorized workspace Agents, Skills, Tools / Connectors, and
Knowledge Sources can be dragged to arbitrary canvas coordinates, moved, and connected
through typed handles. Planned edges can be selected, retargeted, or removed; refused
pairs explain the rule without changing the graph. `Enter`/arrow keys place library rows;
`W`, `Tab`, `Enter`, `Esc`, `E`, `R`, and `Delete` provide the equivalent wiring path.

The library demonstrates search, type/state filters, per-group and overall counts,
collapsed categories, empty results, permission-required and disconnected resources,
compatibility guidance, and a privacy-safe hidden-resource total. Runtime activity still
arrives automatically on the distinct observed layer; replay never re-executes.

Normative interaction and backend/schema assumptions are in
[`../TNG122_FREEFORM_CAPABILITY_COMPOSER.md`](../TNG122_FREEFORM_CAPABILITY_COMPOSER.md).
The focused verifier covers free placement, edge editing, invalid refusal, keyboard parity,
library states, both themes, 1600×1000 and 390 px, reduced motion, replay, regressions, and
offline loading.

The reviewable output of the "Obsidian & Gilt" redesign. No design tool the rest of the
team cannot open.

## Prototype implementation notes — freeform placement and typed wiring

The board asked for free placement and wiring, so screen 5 (**Freeform wiring**,
`#wiring,<theme>`) is a free canvas: **agents, skills, tools/connectors and knowledge sources
drag from the library to any point on the ground**, nodes move freely, and edges are typed.
The library is now the **capability library** — four collapsible groups (Agents, Skills, Tools
& connectors, Knowledge sources) listing everything available and authorized in the workspace,
with search, category and state filters, per-group counts, a match/usable footer, state and
wired badges, compatibility cues on every usable row, and honest states for the rest:
`Needs approval` rows are usable and badge their edges; `Disconnected` / `Not installed` rows
state their reason and cannot be dragged; policy-hidden resources are counted in the footer,
never listed.

Wiring is typed: `starts`, `hands off`, `uses skill`, `invokes`, `reads`,
`produces` — nothing else connects. Pointer (drag a node's right handle onto a target)
and keyboard (`W` arms, `Tab` cycles candidates with announced validity, `Enter` commits,
`Esc` cancels; `R` rewires a selected edge, `Delete` removes, the target endpoint re-aims by drag)
are equivalents. Invalid connections are refused **non-destructively**: the wire strip
(bottom-centre) explains, the strip shakes once, nothing is created. Grey solid edges are your
planned wiring; blue edges + gold shuttle + evidence cards are observed provenance projected
automatically from live run events — the two layers stay visually and behaviourally distinct,
and `Replay observed run` is inert and labelled. The blue breathing border appears only while
the run is active (reduced motion: static 2 px blue). At 390 px the Library becomes a bounded
drawer; tap/keyboard placement, explicit relationship sentences, the connection strip, and the
theme toggle remain available in a prompt-first/output-last column without horizontal overflow.

Spec: [`../TNG89_INTERACTION.md §14`](../TNG89_INTERACTION.md#14-tng-122--tng-123-revision--freeform-placement-typed-wiring-and-the-capability-library)
(including §14.7 backend assumptions, design-only). Verified by
`node docs/mockups/verify-prototype.mjs`, which now also drives placement, wiring,
refusals, library filters, replay, reduced motion, both themes and 390 px on the wiring screen.

## TNG-121 revision — editable live pipeline + overflow repair

The live pipeline is now **editable inside the story**. The **Available team** panel (top
right) lists five placeable agents. Drag a row between two pipeline steps — dashed drop
slots appear between consecutive steps, hover shows a solid accent valid-drop state, drop
inserts the agent. Keyboard path: `Enter` on a row arms placement (slots appear, focus
jumps to the first slot), `Tab` between slots, `Enter` inserts, `Esc` cancels with focus
restored; a live region narrates arm/insert/cancel/remove. The inserted step takes the
next step number, both `delegates review` edges re-anchor through it (the prompt visibly
flows through it to the output), evidence re-anchors to its owner, and the composer chip
recomputes `Pipeline · N steps`. Focus lands on the inserted node; its inspector Delete
button removes it. The demo bounds the pipeline at three steps (`Pipeline full` beyond
that). Insertion mutates the in-memory document only — never the team file, a finished
branch, or a replay; the backend assumptions are design-only and listed in
[`../TNG89_INTERACTION.md §13.6`](../TNG89_INTERACTION.md#136-backendschema-assumptions--design-only-not-implemented).

Overflow repair: every runtime card is bounded (Prompt scrolls internally at 132 px,
response header ellipsizes, evidence lines truncate, lifecycle strip wraps, prior-branch
and run-history lists scroll), and expanded provenance renders in a **bounded tray**
anchored above the stage floor that scrolls internally instead of painting past the stage.
Verified at 1600 × 1000 and 390 px in both Quarry Light and Obsidian & Gilt.

## TNG-119 revision — prompt-to-output is the canvas story

Screens 8–11 now read left-to-right as one inspectable causal graph:

```text
Prompt / user request → Run 01 → Agent A · lead → Agent B · responder → Output / response
                               ↘ agent-owned evidence ↗
```

Every arrow is directional and named. Submitting the Notion example steps through queued,
starting, running/streaming, delegation, seven accepted evidence events, the final responder,
and terminal output. The first event is visibly **Agent A → Notion · invoked tool**; the same
projection then materializes knowledge search, repository, external source, explicit skill,
file, and command evidence from its exact owner. Completion freezes the whole path. Opening
the Output reveals provenance and filters without replacing the path.

Cancelled, partial, failed, and retry rendering retain the exact Prompt and accepted evidence.
Retry creates `Run 02 · Retry of Run 01` plus a separately inspectable previous-branch card;
it never overwrites the original attempt. At 390 px the coordinate edges yield to the same
source-ordered sentence, with relationship words retained on cards.

Normative details and backend boundaries:
[`../TNG89_INTERACTION.md §12`](../TNG89_INTERACTION.md#12-tng-119-revision--prompt-to-output-is-the-primary-graph-narrative).
This is still a prototype/documentation deliverable only; no production UI, API, event, or
schema implementation is included.

## TNG-115 revision — keyboard and narrow-layout remediation

The approval candidate now treats the run workspace as a **Command / Inspect** surface at
narrow widths instead of shrinking the 1600 × 1000 desktop stage. Below 768 px the saved
configuration nodes, lifecycle summary, goal, activity, response, provenance summaries,
evidence, filters, and composer form one readable vertical sequence. Coordinate edges and
the library are intentionally deprioritized in that composition; ownership, order, time,
status, and relationship words remain on the cards. The theme control stays visible, the
composer sticks to the bottom edge, targets grow to at least 44 px, and text keeps its
authored size in both Quarry Light and Obsidian & Gilt. The composer stays docked to the
viewport while the content column scrolls behind reserved bottom space.

Keyboard behavior is now executable rather than merely labelled:

- Agent nodes and live-activity cards are native buttons. `Enter` and `Space` open the
  agent or observed-event inspector, and closing with `Esc` or the close button returns
  focus to the originating card.
- The rich terminal Response remains an article with button semantics because it contains
  prose/code structure that cannot validly live inside a native button. Its explicit
  `Enter`/`Space` handler mirrors click, prevents Space from scrolling, and keeps
  `aria-expanded` synchronized with provenance visibility.
- Provenance summary/entity rerenders restore focus to the owning control. `Esc` collapses
  entity → category → provenance in that order; **Back to response** returns focus to the
  terminal Response.
- Popovers restore focus to their trigger. The document chip is a group with separate
  native Open and Save/Review buttons; the non-action mode display no longer advertises a
  false button role.

The narrow interaction pass covers prompt submission, automatic Agent A → Notion activity,
activity inspection, terminal-response activation, provenance expand/collapse, filtering,
theme switching, and the existing stop/cancel/retry state demonstration. TNG-119 re-composes
desktop runtime geometry around the causal spine; all TNG-113 live ownership behavior remains.

## TNG-113 revision — operational provenance

The board-requested revision is now visible in screens 8–13 without changing the production
UI or backend. Submit the prefilled Notion example on **Composer**: Agent A moves through
`QUEUED → STARTING → RUNNING/STREAMING → DONE`, its node receives a breathing blue border,
and ordered evidence automatically materializes with direct owner edges. The first event is
the explicit **Agent A → Notion** example; knowledge search, repository, external source,
recorded skill use, Agent B file activity, and Agent B command activity follow through the
same renderer.

Every live state keeps a glyph and visible word. `Motion: reduced` replaces the breathing
border with a static 2 px blue perimeter. Gold remains reserved for product emphasis,
selection/focus, and the observed weft; success, error, cancellation, and offline use their
semantic signals. The States screen separately names agent-task, run, result, and replay
lifecycles so `done` and `succeeded` cannot be mistaken for synonyms.

## The approval candidate is one file

**`prototype-standalone.html`** — open it and you have the whole design. One file, inline
CSS and JS, webfonts embedded as base64 `woff2`. **No local dependencies and no network at
all**: it renders identically on a laptop in airplane mode, and it survives being emailed,
dropped in a chat, or copied to a USB stick.

```
open docs/mockups/prototype-standalone.html
```

That file is **generated, never hand-edited** (TNG-99). The first hand-rolled standalone
went stale the moment `prototype.css` changed, which is exactly the failure the generator
removes:

```
node docs/mockups/build-standalone.mjs            # inlines everything, embeds the fonts
node docs/mockups/build-standalone.mjs --no-fonts # zero-network build, system font stack
```

The build fails loudly if any `src`/`href` that is not `#…` or `data:…` survives, so the
artifact cannot silently regain an external dependency.

## The sources it is built from

| File | What it is |
|---|---|
| `tokens.css` | **Normative.** The three-tier token layer, both themes. Liftable almost verbatim into `ui/src/index.css`. |
| `prototype.css` | Component styles built strictly on `tokens.css`. Every rule cites the spec section it implements. |
| `prototype.html` · `prototype.js` | The clickable prototype — **fourteen** screens, both themes. |
| `build-standalone.mjs` | Emits `prototype-standalone.html` from the four files above. |

Review the *design* from the single file. Read the *sources* when you want to see which
spec section a rule cites. They are the same design; only the packaging differs.

Companion specs, unchanged by this folder:
[`../DESIGN_LANGUAGE.md`](../DESIGN_LANGUAGE.md) (the visual language),
[`../UX_REDESIGN.md`](../UX_REDESIGN.md) (the interaction delta over `../CANVAS_SPEC.md`), and
[`../TNG89_INTERACTION.md`](../TNG89_INTERACTION.md) (prompt-to-run, live response, provenance).

**TNG-89 scope was folded in.** Screens 8–11 cover the prompt composer, live response
landing and expandable provenance graph. Their vocabulary — every entity kind, edge kind,
`capture` value, coverage level and run state — is taken verbatim from
[`../RUN_PROVENANCE_CONTRACT.md`](../RUN_PROVENANCE_CONTRACT.md) and
[`../decisions/0005-run-control-and-companion-provenance-channel.md`](../decisions/0005-run-control-and-companion-provenance-channel.md).
Nothing in this folder decides a contract.

---

## How to review it

```
open docs/mockups/prototype-standalone.html
```

That is all — no server, no install, no network. (`prototype.html` also opens directly,
but it needs the other three files beside it.)

**Fonts are embedded.** Inter, JetBrains Mono and Instrument Serif travel inside the file
as base64 `woff2` (latin + latin-ext, SIL OFL 1.1), so the serif `display` step on the
first-run screen and the mono meta rows look the same offline as online. A
`--no-fonts` build falls back to `-apple-system` / `SFMono-Regular` / `Georgia`, which
changes the texture but not a single layout decision.

### Screens

Screens 8–11 are the TNG-89 additions. Deep-linkable, so a review comment can point at an
exact screen and theme — `prototype-standalone.html#team,light`.

| # | Key | Screen | Answers |
|---|---|---|---|
| 1 | `first-run` | First run | What does an empty LoomWatch look like? |
| 2 | `canvas` | Canvas · pipeline | The default working state. Dirty document, two edge layers, one anomaly. |
| 3 | `inspector` | Inspector | How is an Agent edited? |
| 4 | `team` | Canvas · team + live | The observed layer in full voice — all three weft kinds. |
| 5 | `wiring` | Freeform wiring | Place workspace capabilities anywhere and wire them with typed edges (TNG-122/TNG-123). |
| 6 | `switcher` | Document switcher | How do you see, switch and write the file? |
| 7 | `palette` | Command palette | ⌘K as the whole menu. |
| 8 | `problems` | Validation | Incomplete vs. invalid, and how you get to the cause. |
| 9 | `compose` | Composer | Start with a prompt and submit the concrete Notion example. |
| 10 | `running` | Causal run | Prompt → Run → lead/delegation → live agent-owned evidence → streaming Output. |
| 11 | `answered` | Durable path + provenance | The entire partial path remains while six coverage summaries and filters open. |
| 12 | `trace` | Expanded trace | The complete prompt-to-output spine plus direct evidence ownership, details, and capture quality. |
| 13 | `states` | State matrix | Loading, failure, read-only, conflict, empty. |
| 14 | `system` | Design system | Tokens, type, elevation, status, edge layers, every node state. |

### TNG-119 acceptance matrix

| AC | Prototype evidence | Automated verification |
|---|---|---|
| 1 | Durable `Prompt · user request`, `Run 01`, and named `starts` / `assigns lead` arrows | required nodes/labels and directed SVG paths |
| 2 | Timed queued → starting → agent/evidence → responder → terminal sequence | lifecycle transitions and seven ordered evidence cards |
| 3 | Agent A/B ownership plus queued/running/streaming/done/error/cancelled; blue live perimeter | visible state words, semantic classes, reduced-motion computed style |
| 4 | Notion tool, knowledge search, repository, source, skill, file, command | exact card labels/relations and Agent A → Notion edge |
| 5 | Explicit Output / response with producer/run edges; retained partial/cancel/retry branch | terminal path, prior branch, evidence count, run numbering |
| 6 | Submit, inspect, expand/collapse, filter, retry | real keyboard/click events and focus restoration |
| 7 | [`TNG89_INTERACTION.md §12`](../TNG89_INTERACTION.md#12-tng-119-revision--prompt-to-output-is-the-primary-graph-narrative) | documentation phrase/section checks |
| 8 | Both themes, keyboard, reduced motion, 390 px, offline standalone | headless Chrome plus external-reference scan |

### Controls

The dark strip at the top is **prototype chrome, not product design** — it uses its own
neutral values and never touches a token, so it cannot be confused with the design.

| Key | Does |
|---|---|
| `1`–`9` `0` `Q` `W` `E` `R` | screens 1–14, in the table order above |
| `⌘⇧L` | **the theme toggle** — the feature the board asked for |
| `⌘S` | the ledger sweep (the save-to-disk moment) |
| `L` | cycle edge-layer solo: both → configured → observed → both |
| `⌘K` · `⌘P` · `⌘\` | palette · document switcher · library |
| `F8` · `Esc` | problems popover · dismiss |
| `?` | the spec-notes drawer — per-screen rationale with section citations |
| `Motion:` button | simulates `prefers-reduced-motion` |

On a focused node, live-activity card, or terminal Response, `Enter` and `Space` activate
the same path as a pointer click. `Esc` unwinds the active detail level and returns focus to
the control that opened it.

Click a node to open the inspector. The **Notes** drawer is the fastest way to read the
argument for each screen; it carries the decisions and the section numbers.

---

## The two things the board asked for, and where to look

**Dark mode, black + gold.** `#system` in dark. Ground is `#08080A` — near-black, not
navy-black. Gold is *one* accent expressed at two lightnesses per theme, and the gold
**fill** is rationed to roughly one per screen (on the canvas it is the `Save` button; on
first run it is `New team`). Dark mode gets a top-inset rim light and a bloom on live
edges; those two things are why it reads as built rather than inverted.

**Light mode re-tuned to match.** Toggle any screen. Light is "quarry": warm paper
`#FAF8F3`, not white, and gold drops to a **bronze** (`gold-600`, 4.76:1) so it can legally
carry text. Both themes reassign the *same* tier-2 names — `--color-accent` is gold in one
and bronze in the other, and no component knows which. That shared layer is what makes them
one system instead of two moods.

---

## Deltas — design changes the prototype forced

Building the design at 1:1 caught eight things the written specs got wrong or left
ambiguous. **These override the companion documents where they conflict**, and are the
substantive part of what the board is being asked to approve.

1. **The `ENTRY` text pill is withdrawn.** `UX_REDESIGN §5.1` put a `micro` "ENTRY" pill
   left of the status indicator. Measured: it costs 58 px of the name's width, and at
   276 px the name truncates to "Protocol Rese…" — the product's most important string,
   truncated in the default case. The entrypoint already has a channel: the 2 px accent
   **ring around the role glyph**, which is also `CANVAS_SPEC §8.2`'s team-mode entrypoint
   marker. Two channels for one fact, one of them expensive, is the thing to cut. The
   accessible name still ends `", entry point"`, and the inspector still states it.

2. **The validity dot moves from top-left to top-right.** `§5.2` put the
   incomplete/invalid dot at the node's top-left; `CANVAS_SPEC §8.2` puts the pipeline
   **step number** in the same corner. In pipeline mode with a freshly dropped node — the
   single most common state — they collide. Step badge stays top-left (outside), validity
   dot moves to top-right (outside). Validity and execution order now read as a pair
   instead of fighting.

3. **The node's internal rhythm is fixed to exactly 96 px.** `§5.1`'s padding arithmetic
   totals 97 px, which silently flex-shrank the 3 px budget lane to 0.7 px. Correct budget:
   `13 (pad-top) + 37 (name+role) + auto + 1 (rule) + 8 + 18 (meta) + 3 (lane) = 96`. Every
   child is `flex: none` and the rule takes `margin-top: auto`, so the lane pins to the base
   and can never be squeezed. **Build note:** if the lane is thinner than 3 px, a child lost
   its `flex: none`.

4. **The layer legend uses sentence-case `meta`, not uppercase `micro`.** "CONFIGURED" +
   swatch + count does not fit in `§6.7`'s 148 px. `§6.7`'s own diagram shows sentence case;
   the type step was the error. 148 px stands.

5. **Middle truncation needs ~12 lines of JS.** `§4.1` ("middle-truncated for paths") and
   `§5.1` ("model middle-truncates") cannot be done in CSS — `text-overflow` truncates one
   end only. A path carries meaning at *both* ends: tail-truncating
   `/Users/me/Library/Application Support/claude/bin/claude` loses the binary,
   head-truncating loses the root. `middleTruncate()` in `prototype.js` is the reference
   implementation (binary search on `scrollWidth`, full string in `title`).

6. **The anomaly midpoint badge is `⚠` alone**, with the explanation in `title` and the
   count on the mode pill. A label long enough to be self-explanatory
   ("⚠ SKIPPED REVIEWER") is wider than the node it sits beside.

7. **Observed edges are rare in pipeline mode, by construction.** Not a change — a
   consequence of two rules meeting, which the engineer needs stated: a coincident observed
   edge becomes a *shuttle on the configured path* (`§13`) and a non-coincident one is by
   definition an *anomaly* (`§6.8`). So gold dashed weft in full voice only ever appears in
   **team** mode. That is why the prototype ships screens 2 *and* 4; a reviewer looking only
   at pipeline mode would conclude the weft vocabulary was unused. **The board should
   confirm this is the intent** — the alternative is to allow non-anomalous weft in pipeline
   mode, which weakens what an anomaly means.

8. **Open detail:** in team mode the legend reads `Configured 0`, because `edges: []` is
   what *makes* it team mode. Kept for a consistent solo control. If it reads as a defect
   rather than a fact, the row should be hidden when the count is 0. Deferred to review.

### TNG-89 deltas — see `../TNG89_INTERACTION.md §9` for the full list

9. **The mode pill becomes the composer's mode chip.** It explains how the document will
   execute; that is worth most at the moment you execute it. This spends the 36 px run slot
   `CANVAS_SPEC §14` reserved.
10. **The run slot is start-only, and now enabled.** `RUN_PROVENANCE_CONTRACT §3.2` places
    pause, resume, steering and cancellation outside the contract, and `ARCHITECTURE §6`
    defers writes to running execution. **There is no Stop control** — that would be an §6
    amendment plus a contract change, not a button.
11. **A runtime overlay layer joins the z-order.** Runtime nodes are tinted and ringed;
    configuration nodes are opaque and bordered. *If it is filled and bordered it is in the
    file; if it is tinted and ringed it came from a run.* This is how the operator can trust
    that a run never touched their YAML without reading the file — which TNG-89E and
    TNG-89F both require.
12. **Provenance edges share one stroke for all ten kinds**, never animated, kind on hover.
    Ten more stroke treatments would drown the two that carry `ARCHITECTURE §5`'s named
    configured-vs-observed requirement, and animation means *happening now* in this
    language.
13. **`Save & run` replaces "run without saving."** A run executes an exact byte snapshot
    (`ADR 0005 §1`), so offering "run without saving" would mean running either stale or
    unreviewed bytes. Both break the reviewability the snapshot exists to provide.
14. **Two channels, two gap indicators.** `RunEvent.seq` and the provenance `cursor` are
    recovered independently, so they get separately-worded strips that each name the
    watermark they are complete to. One merged "something's wrong" would be a lie about
    which half of the picture is stale.

### Build notes for the engineer

- `#chip { position: relative }` was the one real bug in this prototype: an id selector
  out-specifies `.panel { position: absolute }` and drops the chip into normal flow, where
  it stretches to full width. Absolute positioning already gives the ledger sweep its
  containing block. Watch for this wherever a Tailwind-era id rule survives the port.
- `tokens.css` is written so the light tier-2 block becomes `@theme { }` and
  `[data-theme="dark"]` becomes `.dark`. Tier 1 is deliberately *not* in `@theme`: it must
  not generate utilities, because a `bg-lw-gold-400` utility is exactly how the one rule
  gets broken.
- `[hidden] { display: none !important }` is required, because every panel here is styled
  by id.
- **`const` is not hoisted.** The TNG-89 block defines `CAPTURE`, `COVERAGE`,
  `TOOL_ENTITIES` and `COMPOSER`, and the `SCREENS` object literal references them. Appending
  that block after `SCREENS` put them in the temporal dead zone and killed the whole module
  with an opaque `Script error.` under `file://`. `prototype.js` now asserts every `ORDER`
  key resolves in `SCREENS` before building the tab strip, so this class of failure is loud
  instead of silent.

---

## What was verified, and how

### TNG-87 follow-up — the drag affordance overpromised on every non-wiring screen

The board's rejection screenshot for TNG-127 was taken on the **canvas** screen
(`"Pipeline · 3 steps"`), not wiring. Even after TNG-127's `user-select` fix let `dragstart`
arm correctly in WebKit, `dragstart`/`dragover`/`drop` and Enter-to-arm are wired **only** to
`stage.dataset.screen === 'wiring'` — but `libRowHTML` rendered `draggable="true"`, a resting
grab cursor and the drag-dots handle unconditionally on every screen the library appears on
(canvas, inspector, team, switcher, palette). A retest on the board's actual screen would still
have read as "I still cannot drag" — just silently, instead of via a text highlight.

Fixed by scoping the affordance's *appearance* to where it actually works, rather than
extending drop-handling to every screen (a bigger, riskier change for a critical, repeatedly
rejected issue): `draggable="true"`, the grab cursor and the drag-dots handle now only render
when `stage.dataset.screen === 'wiring'`. Elsewhere the row stays focusable, its title/aria-label
name the Freeform wiring tab instead of claiming "Press Enter to arm placement," and pressing
Enter narrates the same redirection through `#liveRegion` instead of silently no-op'ing.

`verify-prototype.mjs` now asserts, on the canvas screen: zero library rows carry
`draggable="true"`, zero carry a drag-dots handle, zero compute a `grab` cursor, every usable
row's title and aria-label name the Freeform wiring tab, and Enter on such a row updates
`#liveRegion` with that redirection instead of arming placement. The pre-existing wiring-screen
assertions (resting grab handle, drag-not-selection invariant) are unchanged and still pass —
this only removes a false affordance elsewhere, it does not touch the screen where dragging is
real. Re-ran `verify-webkit.swift` after this change: both passes still green, confirming the
text-selection lock from TNG-127 is untouched.

### Cross-engine gate (TNG-127) — run this before any drag fix goes to the board

`verify-prototype.mjs` drives **headless Chrome only**, and that blind spot shipped a
rejection. Chromium's UA stylesheet already forces `user-select: none` on
`[draggable="true"]` and its descendants, so when the prototype declared `user-select`
nowhere, every library row still reported `none` under test — while on Safari, pressing a row
started a *text selection* and the drag never armed. Five consecutive self-checks passed on a
gesture that did not work.

So drag/selection behaviour is now also proven in WebKit:

```
swiftc -O docs/mockups/verify-webkit.swift -o /tmp/verify-webkit
/tmp/verify-webkit docs/mockups/prototype-standalone.html
```

It loads the shipped standalone into a real `WKWebView` — the engine Safari uses — and probes
it twice: once as shipped, once with the author rule defeated. The second pass is the
counterfactual Chrome cannot produce; it reproduces the pre-fix state and proves WebKit has
no UA fallback, so the rule is load-bearing rather than decorative. Delete the rule and pass A
fails; lean on a UA sheet that only Chromium has and pass B fails.

Uses only the macOS command-line tools (Swift + WebKit). No Safari automation, no admin
enablement, no package install.

### Affordance sweep — run this before any candidate goes to the board

The gate above proves a *named* fix. It cannot tell you about the control the board presses
next, and that is what four rounds were actually lost to: each rejection was closed
correctly, and each following round found the next silent control on the same screen.

```
swift docs/mockups/verify-webkit.swift \
  docs/mockups/prototype-standalone.html \
  --eval docs/mockups/webkit-probe-canvas-affordances.js
```

This enumerates every reachable affordance on the default `canvas` screen — the only screen
the board reviews — and asks each one the reviewer's question: *I pressed it, did anything
happen?* Any change to the serialized document, screen, node model, focus, or scroll counts,
because the point is to clear controls rather than assert a behaviour. The live count is
printed alongside the failures: if a run flags everything, the detector is broken, not the
page.

Current state: **31 of 33 answer a press, none dead.** The five that did not are fixed and
written up in `TNG87_AFFORDANCE_SWEEP.md`.

### Promised behaviour, not mere liveness — run these two as well

The sweep clears controls that answer nothing. It cannot catch a control that answers the
*wrong* gesture, and it cannot catch a wrong answer. Both of those shipped past it:

```
swift docs/mockups/verify-webkit.swift docs/mockups/prototype-standalone.html \
  --eval docs/mockups/webkit-probe-canvas-node-drag.js
swift docs/mockups/verify-webkit.swift docs/mockups/prototype-standalone.html \
  --eval docs/mockups/webkit-probe-canvas-view-controls.js
```

`canvas-node-drag` presses, drags and releases every node on `canvas` **and** `wiring`, and
asserts the node moved in its model and that its edges followed *while the pointer was
down*. A node is a `<button>`, so pressing it selects it and the sweep scores it live — that
blind spot is how "I cannot move these 3 items" reached the board on a screen every gate
called clean. The two surfaces are each other's counterfactual, and the probe also pins the
graph's at-rest geometry so a fix to the edges cannot silently redraw the reviewed picture.

`canvas-view-controls` asserts what the new controls *do*: the graph scales and the chrome
does not, the §7.1 range clamps at both ends, a drag at a zoom other than 1.0 still lands
under the pointer, Fit frames a deliberately scattered graph inside the space the panels
leave free, and the §8.1 mode popover explains the mode it is actually in.

### TNG-90 state gate — the thirteen named states, asserted on the screens that show them

```
node docs/mockups/verify-tng90-states.mjs
```

TNG-90's acceptance criteria require twelve run and provenance states to be *demonstrated*; a
thirteenth — finished-with-no-answer (`missing_canonical_response`, §3.4) — was added after
TNG-166 found the implementation calling that outcome a crash, because a state the reference
artifact never draws is a state an implementer has to invent. The gates above cannot
see whether a reviewer can reach one: a state can be complete in the data tables and invisible
on every screen, and a grep for its label passes either way, because the label is in the
source. That is exactly how `dirty / Save & run` shipped missing — `COMPOSER.dirty` holds the
string, nothing ever renders it, and "Save & run" greps three hits.

So each check resolves a state through the screen a reviewer opens and asserts the promised
content there. Comparative claims carry their counterfactual, because an assertion that cannot
fail is not a gate: dirty is asserted against clean, the transport gap against the finished
run, and one-hop expansion against the graph not exploding (six categories survive, exactly
one opens).

Three traps this probe already fell into and now documents, so nobody re-reports them:

- the answer is `.rt-response`. Measuring `.rt-body` reads the **prompt**, scores the response
  at 67 characters, and calls a healthy screen broken.
- the prototype keeps **hidden specimens** of the other terminal strips in the DOM, so
  `.rt-strip.halt` presence is not visibility — the cancelled strip sits on every run screen
  with `offsetParent === null`. Filter on layout.
- on `trace` the six category chips are **deliberately** replaced by a breadcrumb, because
  `run.openEnt` is set and showing both would be two hops on screen at once
  (`prototype.js`, the `if (run.openEnt) return;` guard in the category loop). Gate the depth
  the screen is actually in.

A run started from a dirty document is **asynchronous** — §1.4 requires the write to land
first — so anything asserting a run must wait for it to be created rather than read the next
tick. Freezing the timers immediately freezes the *save*, before any run story exists.

### TNG-90 counterfactual pass — 12 mutations, all 12 caught

```
node docs/mockups/defeat-tng90-states.mjs
node docs/mockups/defeat-tng90-states.mjs --only 3,12     # a subset, by number
```

`verify-tng90-states.mjs` is one of exactly two gates that read the artifact the board is
being asked to approve, and it had only ever printed `47 passed, 0 failed`. That number is
equally consistent with *"the artifact holds thirteen states"* and *"the probe stopped
looking"* — a distinction two gates in this repo have already failed (TNG-203, TNG-205),
both of which went blind while staying green. The load-bearing one had no counterfactual at
all.

So this reproduces, one at a time, twelve regressions the gate claims to catch — the
thirteenth state reporting `process_crashed` again, the chip frozen on clean, a bare `Run`
on a dirty document, an expansion that opens the wrong category, five categories instead of
six, categories re-sorted by count, a reveal affordance on a redacted card, the transport
gap strip dropped, both themes resolving to one ground, an infinite animation surviving
reduced motion, the specimen gallery shipping visible, and the reason deleted from an
unavailable card. Each requires its own named check to go red. **12/12.**

The pinned artifact is never touched: each mutation is applied to a copy, in a scratch
directory beside a copy of the gate, and the gate resolves its artifact relative to its own
file — so the mutant is measured by the shipped probe, byte for byte, while
`prototype-standalone.html` keeps its `a339e26a…` hash throughout.

**It found one blind contract, in the gate.** `capture gap — unavailable evidence states a
reason` measured the whole card's `innerText` at `length > 20`. Delete the reason and the
card still carries name, kind, owner and capture word — 61 characters — so the check passed
with the thing it names absent. It now reads the reason's own span (`.e-sub.t-meta`; the
`e.sub` beside it is `.t-mono-sm`), and the same mutation reddens it. The gate still scores
47/0 on the pinned artifact.

Three mutations that changed the file and changed nothing on screen — each of which reads as
an *uncaught defect* rather than as a no-op, which is why the harness treats a missing anchor
as a harness error and exits 2:

- editing `COMPOSER.dirty.act` does not change the composer. The screen router calls
  `renderComposer()` and then `paintRun()`, and `paintRun()` rewrites `#compAct` from its own
  `dirtyIdle` branch. This is the same dead table entry noted above — mutate the render.
- deleting `hidden` from the specimen board lasts until the first paint; the router re-sets
  `hidden` on every panel it is not showing.
- relaxing `.board[hidden] { display: none }` loses the cascade to the blanket
  `[hidden] { display: none !important }` the prototype carries for its id-level rules.

The specimen gallery holding the capture cards is **`#system`** (`#capRow` and `#capGrey`),
not `#states`. Both are `.board`; the gate's own comment named the wrong one, and now names
the right one.

### TNG-90 counterfactual pass, second gate — 14 mutations, all 14 caught

```
node docs/mockups/defeat-prototype.mjs
node docs/mockups/defeat-prototype.mjs --only 1,8        # a subset, by number
node docs/mockups/defeat-prototype.mjs --no-control      # skip the unmutated control run
```

`verify-prototype.mjs` is the **second** of exactly two gates that read the artifact the board
is being asked to approve, and the only evidence for it anywhere — on the Gate B card, and in
the CEO's independent re-check — is the word *"pass"*. It is fail-fast: one `assert` throws and
the run stops, so a green run prints a single sentence covering roughly sixty contracts and
says nothing about which of them were exercised. Its sibling at least printed a count; this one
printed a claim.

So this reproduces, one at a time, fourteen regressions the gate claims to catch — the board's
own press-drag-release landing the row somewhere other than the release point, the grab handle
withheld off the wiring screen again, `draggable="true"` leaking onto screens with no drop
wiring, the shell going text-selectable, the `-webkit-` fallback stripped from the shipped
bytes, the answer losing its selectability, the running border animating under reduced motion,
the narrow layout scaling the desktop stage, the one narrow view control pushed off the right
edge, the touch floor dropping to 32 px, replay losing its label, a refusal that does not
explain itself, a deletable prompt origin, and one remote image. Each requires the gate to go
red **on that contract's own assertion message**. **14/14**, in under two minutes.

Three verdicts, because "the gate went red" is not the same claim as "this contract caught it":

- **DEFEATED** — red, and the message is the one this mutation targets.
- **NOT CAUGHT** — green with the defect in place; the contract is decorative.
- **WRONG CONTRACT** — red somewhere *earlier*. The gate stops at its first failure, so the
  target assertion never ran, which is no evidence about the target. Counted as a failure.

**Run 0 is an unmutated copy, and it has to come out green.** Fourteen reds prove nothing if
the copy-pair harness reddens on its own; a red control exits 2 rather than reporting a score.
The pinned artifact is never touched — each mutation is applied to a copy, in a scratch
directory beside a copy of the gate, and the gate resolves its artifact relative to its own
file, so the mutant is measured by the shipped probe, byte for byte, while
`prototype-standalone.html` keeps its `a339e26a…` hash throughout.

**What it found is where three contracts actually live** — the first draft of three mutations
changed the file and changed nothing on screen, and each read as an uncaught defect rather than
as a no-op:

- `fit()`'s `stage.style.transform = 'none'` is belt to the CSS braces. The narrow `#stage` rule
  carries `transform: none !important`, which outranks any inline value, so **the no-scale
  contract is held in CSS** and mutating the JS line proves nothing about it.
- `#viewctl .iconbtn { width: 44px; height: 44px }` is a restatement. The blanket
  `.btn, .iconbtn, .filt, .seg button { min-height: 44px }` is what actually produces 44, and
  `min-height` beats a smaller `height` — so **the touch floor needs both edits** to move at
  all. That mutation is the only one here carrying an `edits` list.
- the reduced-motion floor for a running node is the **specific** rule at (0,4,0), not the
  blanket `[data-motion="reduce"] *`, which only caps duration and iteration count. An injected
  `[data-motion="reduce"] .story-agent-a { … !important }` is (0,2,0) and loses to it — so the
  "new surface escapes the floor" shape is not reproducible on this element, and the edit that
  reproduces the regression is removing the rule that holds it.

All three of those read as **NOT CAUGHT** before they were traced, which is what the verdict is
for: the harness reports a no-op as an uncaught defect rather than quietly scoring it green.

### TNG-115 remediation — 26 focused browser assertions, all passing

Run `node docs/mockups/verify-prototype.mjs`. The verifier launches headless Chrome with
external name resolution disabled and drives actual keyboard events against the generated
standalone. It covers node/inspector activation and focus return, live-activity inspection,
terminal Response and provenance expansion/collapse, filter state across rerenders,
keyboard prompt submission, and cancel/retry continuity. At 390 × 844 it checks both
themes, an unscaled stage, 14 px response text, a reachable 44 px theme target, a
viewport-docked composer, and no horizontal overflow.

### Packaging (TNG-99) — 43 automated checks, all passing

`prototype-standalone.html` was driven in headless Chrome at 1600 × 1000 launched with
`--host-resolver-rules=MAP * ~NOTFOUND`, so **the network is unreachable for the entire
run**. Anything that needed a CDN would have failed rather than degraded quietly.

- **Zero** non-`file:`/`data:` requests, zero loading failures, zero console errors.
- The prototype module executed: the tab strip built all thirteen entries.
- All three webfonts reach `loaded` from their embedded `data:` URIs. Inter is confirmed to
  be the *variable* file (400 and 600 measure different advance widths, 485.89 px vs
  496.02 px on the same string) and is confirmed not to be silently falling back to the
  system sans (464.72 px).
- **All thirteen screens × both themes = 26 checks.** Each asserts the screen actually
  became current, that the stage is still 1478 × 924 after `fit()`, and that at least two
  stage layers are visible and laid out.
- The theme toggle is exercised through the product's own `toggleTheme()` — not by setting
  the attribute — so a broken `paintTheme()` cannot pass. Both the `data-theme` attribute
  and the `theme-dark` stage class are checked, and the two themes are confirmed to paint
  different grounds: `#08080A` dark, `#FAF8F3` light.
- `⌘⇧L` flips the theme via **real dispatched key events**, not a function call.
- Both edge layers (warp + weft) are present in the SVG on the canvas screen.
- Deep links resolve: `#team,light`, `#trace,dark`, `#system,light`, and no hash → `canvas`
  in dark.

### Design (TNG-87)

Verified in headless Chrome at 1600 × 1000 (the `≥1280` layout of `§13`), both themes, all
thirteen screens:

- JS parses and executes; no missing DOM targets.
- Node fill measured uniform `#131316` across the full 96 px (checked by sampling the
  rendered PNG, after a suspected banding artifact).
- Node geometry measured at 276 × 96 with the budget lane at its full 3 px.
- Chip, library, legend, mode pill and view controls measured at their specified widths.
- Middle truncation produces `/opt/homebre…bin/opencode`, not a lost tail.
- The **greyscale proof** of `DESIGN_LANGUAGE §16` is rendered as a live column on screen 13:
  drop all colour and the five edge rows and eight status rows stay distinct. This is the
  acceptance test, run rather than asserted.
- The same proof is rendered for the **four `capture` states** (screen 13): without colour
  they remain `solid+dot` / `dashed+ring` / `solid+hatch+lock` / `dotted+dashed-ring`.
- Runtime-overlay layout was corrected three times against screenshots — the response node
  overlapped the provenance header, provenance entities overlapped each other and the filter
  panel, and a `succeeded` answer was rendering above a `failed` agent. All were found by
  looking, not by reasoning.

Not verified, and honestly out of reach here:

- **Contrast ratios were not recomputed.** The numbers in `DESIGN_LANGUAGE §4` are carried
  from that document; `§16` requires the built app to match them to ±0.05, and that check
  belongs in CI against the real stylesheet, not in a mockup.
- Real pointer interaction (drag-to-instantiate, edge drawing, marquee select) is specified
  but not simulated — the prototype covers the *states* those flows produce, not the
  dragging itself.
- No macOS/Safari pass; Chrome only.

---

## Boundaries this design respects

- **No mid-run execution controls.** No approve, pause, comment-while-running, and — after
  TNG-89 — **no Stop, no cancel, no steering.** `RUN_PROVENANCE_CONTRACT §3.2` puts them
  outside the contract and `ARCHITECTURE §6` defers writes to running execution. The
  composer is start-only. (Before TNG-89 the run slot was reserved and disabled; TNG-89
  authorized starting a run and nothing more.)
- **No backend or schema decisions.** The document switcher runs on `GET /api/teams`
  (shipped, TNG-74) and `GET /api/team?path=`; nothing here asks for a new endpoint or a
  field. The open items are unchanged and still listed in `UX_REDESIGN §17` — including
  **§17.4, the config-change push channel, which is escalated** because a non-`RunEvent`
  message cannot go down the frozen WebSocket (`WEBSOCKET_SCHEMA §1`). The proposal is a
  separate SSE stream; it is not decided here.
- **One operator.** No personas, no onboarding funnel, no empty-state marketing. The entire
  onboarding is a ghost node and one six-second line.
