# LoomWatch — TNG-87 design artifacts

The reviewable output of the "Obsidian & Gilt" redesign. No design tool the rest of the
team cannot open.

## TNG-113 revision — operational provenance

The board-requested revision is now visible in screens 8–13 without changing the production
UI or backend. Submit the prefilled Notion example on **Composer**: Agent A moves through
`QUEUED → STARTING → RUNNING/STREAMING → DONE`, its node receives a breathing blue border,
and ordered evidence automatically materializes with direct owner edges. The first event is
the explicit **Agent A → Notion** example; knowledge search, repository, external source,
Agent B file activity, and Agent B command activity follow through the same renderer.

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
| `prototype.html` · `prototype.js` | The clickable prototype — **thirteen** screens, both themes. |
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
| 5 | `switcher` | Document switcher | How do you see, switch and write the file? |
| 6 | `palette` | Command palette | ⌘K as the whole menu. |
| 7 | `problems` | Validation | Incomplete vs. invalid, and how you get to the cause. |
| 8 | `compose` | Composer | How does a goal get from the operator to the team? |
| 9 | `running` | Live response | Current agent tasks, blue execution perimeter, and automatic Agent A/B evidence ownership. |
| 10 | `answered` | Provenance | A `partial` answer, semantic error treatment, and six coverage summaries. |
| 11 | `trace` | Expanded trace | Direct agent → evidence ownership, ordering/time/status, details, and all four evidence-quality states. |
| 12 | `states` | State matrix | Loading, failure, read-only, conflict, empty. |
| 13 | `system` | Design system | Tokens, type, elevation, status, edge layers, every node state. |

### Controls

The dark strip at the top is **prototype chrome, not product design** — it uses its own
neutral values and never touches a token, so it cannot be confused with the design.

| Key | Does |
|---|---|
| `1`–`9` `0` `Q` `W` `E` | screens 1–13, in the table order above |
| `⌘⇧L` | **the theme toggle** — the feature the board asked for |
| `⌘S` | the ledger sweep (the save-to-disk moment) |
| `L` | cycle edge-layer solo: both → configured → observed → both |
| `⌘K` · `⌘P` · `⌘\` | palette · document switcher · library |
| `F8` · `Esc` | problems popover · dismiss |
| `?` | the spec-notes drawer — per-screen rationale with section citations |
| `Motion:` button | simulates `prefers-reduced-motion` |

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
