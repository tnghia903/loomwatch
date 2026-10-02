# LoomWatch — UX redesign delta

Revision 2 · 2026-09-10 · **approved by the board 2026-09-10 (TNG-87); implemented in `ui/` 2026-09-11 — see [ADR 0009](decisions/0009-prompt-to-output-workspace-shipped.md)**

This document is a **delta against [CANVAS_SPEC.md](CANVAS_SPEC.md)**, not a replacement.
Sections are numbered to match it. Anything CANVAS_SPEC says that is not contradicted here
still holds. The visual language is in [DESIGN_LANGUAGE.md](DESIGN_LANGUAGE.md) (rev 3) and
all tokens below are that document's.

A delta rather than a rewrite is deliberate: CANVAS_SPEC is 1 367 lines of verified detail
against `team.schema.yaml`, `TEAM_CONFIG.md` and the shipped REST surface. Re-typing it to
change eleven things would lose that verification and create drift. **On approval, this
delta is folded into CANVAS_SPEC as revision 2** and this file is deleted.

**Scope guard.** Configuration only. No mid-run execution control — approving, pausing or
commenting on a running agent stays deferred by ARCHITECTURE §6 and is not designed here.
The original redesign below does not require a change to `schemas/team.schema.yaml` or the
frozen WebSocket schema; later approval-candidate revisions may state explicit design-only
backend/schema assumptions. Those assumptions are not authorization to implement them.

## TNG-119 approval-candidate revision

The runtime canvas is now composed as a **Monitor** surface whose first read is the complete
causal sentence: **Prompt / user request → Run → lead Agent A → delegated Agent B → each
agent's evidence → Output / response**. Named directional edges carry `starts`, `assigns
lead`, `delegates review`, evidence relations, `responds with`, and `completes as`. The
Prompt, attempt, agents, accumulated evidence, and terminal Output remain visible while the
reviewer expands/collapses provenance or changes filters. Retry keeps the original Prompt,
retains a prior-branch evidence summary, and creates a distinct next run attempt.

This revision changes only the design prototype and documentation. The complete information
hierarchy, node vocabulary, edge semantics, ordering/retention rules, live-versus-replay
behavior, keyboard/focus contract, token discipline, rationale boundary, and explicit
backend/schema assumptions are normative in
[`TNG89_INTERACTION.md §12`](TNG89_INTERACTION.md#12-tng-119-revision--prompt-to-output-is-the-primary-graph-narrative).

## TNG-121 revision — the live pipeline is editable, and nothing overflows

Board rejection feedback on TNG-87 named two gaps: the composed pipeline could not be
modified inside the live-canvas story, and node/history content overflowed its cards.
Both are addressed in the prototype only.

**Editable pipeline.** A new **Available team** panel (top right, 340 px) lists five
placeable agents — three detected harnesses and the two role presets. A row is a drag
*and* keyboard source:

- **Pointer:** dragging a row renders dashed **drop slots between every consecutive pair
  of pipeline steps** (never at the ends — the prototype pins lead and responder).
  Hovering a slot flips it to a solid accent "valid drop" state; dropping inserts the
  agent there.
- **Keyboard:** `Enter` on a row arms placement (the row gains an accent treatment and
  the slots appear, focus moves to slot 0). `Tab` between slots, `Enter` inserts,
  `Esc` cancels and restores focus to the row. A polite live region announces arm,
  insert, cancel, and removal.
- **The graph updates, not the copy:** the inserted step takes the next step number, both
  `delegates review` edges re-anchor to it, evidence re-anchors under its new owner
  position, and the composer chip recomputes `Pipeline · N steps`. Focus lands on the
  inserted node; the inspector's Delete button removes that step.
- **Bounds:** three steps maximum in the demo (the causal story stops being legible past
  that); the palette reports `Pipeline full` and placement is refused (announced, not
  silent). Inserted presets are valid; raw harness rows are `incomplete` until given a
  role/model, exactly like a Library drop.
- **Scope:** insertion mutates the in-memory document only. It never writes runtime nodes
  to the team file, never rewrites finished/replayed branches, and saving is still `⌘S`.
  Backend assumptions are listed in `TNG89_INTERACTION.md §13.6` and are **not**
  implemented.

**Overflow repair.** Every runtime card is bounded: the durable Prompt grows to 132 px
then scrolls internally; the response header ellipsizes before it can push its Live/Replay
badge out; evidence-card lines truncate inside the 180 px card; the lifecycle strip wraps;
the prior-branch card scrolls internally; run-history rows clip long goals and the list
scrolls. Expanded provenance moved from free absolute positions (which overflowed the
1000 px stage to y ≈ 1046 with an entity open) into a **bounded tray** that anchors above
the stage floor, scrolls internally, and carries `Back to response` in its header. At 390 px
the tray becomes a full-width block in the reading column.

## TNG-122 revision — freeform capability composer supersedes fixed insertion

The TNG-121 between-step insertion lane is no longer the approval candidate. The canvas is now
primarily an **Operate** surface: users place workspace-authorized resources at arbitrary
coordinates, move them, and create, select, atomically retarget, or remove typed planned edges.
Capability discovery is a secondary **Explore** mode in a searchable, filterable, collapsible
Library; the selected-object strip and inspector provide **Command / Inspect** behavior.

The Library's first-class draggable types are Agents, Skills, Tools / Connectors, and Knowledge
Sources. It shows only the current workspace's safely discoverable inventory, including explicit
disconnected or permission-required states only where that metadata itself is authorized. Globally
hidden and unauthorized inventory is omitted. Prompt / goal remains the graph origin and Response /
output remains terminal.

Planned wiring is editable intent and cannot claim that a capability ran. Actual calls, commands,
searches, files, repositories, knowledge access, skills, handoffs, and output ownership continue to
project automatically from accepted runtime events as immutable observed evidence. The full typed
relationship matrix, pointer and keyboard interactions, refusal behavior, permissions model,
narrow-layout reading order, and design-only backend/schema assumptions are normative in
[`TNG122_FREEFORM_CAPABILITY_COMPOSER.md`](TNG122_FREEFORM_CAPABILITY_COMPOSER.md).

This revision does not amend `team.schema.yaml`, grant permissions, add endpoints, or change the
frozen WebSocket contract. Production persistence and validation require deliberate backend/schema
ownership and review after the DESIGN-FIRST gate.

---

## 0. The eleven changes, and why each one

Ordered by how much better the product gets, so a reviewer can cut from the bottom.

| # | Change | The problem it fixes |
|---|---|---|
| 1 | **Document chip becomes a document switcher** (§9.1) | `?path=` is currently the only way to open a team. `GET /api/teams` has shipped and nothing consumes it. The operator's own files are unreachable from the UI. |
| 2 | **The save-to-disk moment is staged** (§9.1) | ARCHITECTURE §5 says the files are the truth; "Unsaved changes" in 12 px grey is not an obvious save-to-disk moment. |
| 3 | **Layer solo — `L`** (§6.7) | The two-edge-layer requirement is legibility-critical, and on a graph with ten nodes and thirty observed events, "distinguishable at a glance" needs an off switch, not just a good stroke. |
| 4 | **A real state matrix: loading, offline, error** (§16) | CANVAS_SPEC has excellent empty states and **no loading or transport-failure states at all**. The most likely thing to go wrong — the daemon dies, the socket drops — currently renders as a canvas that quietly stops updating. |
| 5 | **Node re-proportioned, 264×88 → 276×96** (§5.1) | The name shared a type step with an inspector label, and the budget meter Phase 05 needs was a promise to "reserve 4 px" inside a box that had none. |
| 6 | **Inspector re-zoned into Identity / Behaviour / Process** (§5.4) | A flat field list makes `role` (the point of the node) look as important as `env`. |
| 7 | **Problems are navigable, not just listed** (§9.2) | Validation blocks the save; the only way to the offending field was to guess. `F8` cycles. |
| 8 | **Theme toggle in permanent chrome** (§3) | Board direction. It was buried in ⌘K. |
| 9 | **Library gets a loading skeleton and a tighter rhythm** (§4) | Harness detection is a filesystem scan; the panel currently pops in. |
| 10 | **Edge legend, conditional** (§6.7) | Two-layer semantics were only explained in a document nobody reads at 2 a.m. |
| 11 | **First-run composition retuned** (§10.1) | It is the screen that sets the tone and it was carrying a 28 px sans headline. |

Nothing here adds a persistent surface. The count of floating elements stays at **five**,
plus one conditional legend and one conditional bar — the same budget CANVAS_SPEC §3 set.

---

## 3. Overall layout — amended

One full-bleed canvas. Five floating elements, all `e1`. **Inset moves 16 → 20 px.**

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 20px inset                                                                      │
│  ┌─ LIBRARY ─────────┐      ┌──────────────────────────────────┐                │
│  │ 288 px            │      │ ◆ research-team.yaml    ⌄        │  ← document    │
│  │ collapsible → 48  │      │   3 lines differ    [ Save ⌘S ]  │     switcher   │
│  │                   │      └──────────────────────────────────┘   (top centre) │
│  │                   │                                                          │
│  │                   │       ┌────────────────┐      ┌── INSPECTOR ──┐          │
│  │                   │       │   agent node   │      │ 320 px        │          │
│  │                   │       └────────┬───────┘      │ IDENTITY      │          │
│  │                   │                │              │ BEHAVIOUR     │          │
│  │                   │                ▼              │ ▸ PROCESS     │          │
│  │                   │       ┌────────────────┐      │               │          │
│  │                   │       │   agent node   │      │               │          │
│  └───────────────────┘       └────────────────┘      └───────────────┘          │
│                                                                                 │
│  ┌───────────────┐        ┌────────────────────────┐        ┌──────────────┐    │
│  │ ── warp       │        │ ⇉ Pipeline · 3 steps ▸ │        │ −  +  ⤢  ◐   │    │
│  │ ┄▸ weft   ×4  │        └────────────────────────┘        └──────────────┘    │
│  └───────────────┘            mode pill (bottom centre)      view controls      │
│   layer legend                                                                  │
│   (only while observed edges exist)                                             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

| Element | Position | Size | Presence |
|---|---|---|---|
| **Library** | top-left, inset 20 | 288 × `calc(100% − 40px)`, max 640 then scrolls | persistent, collapsible to a 48 px rail (`⌘\`) |
| **Document switcher** | top-centre, inset 20 | auto × 44, min 280 | always (except first run) |
| **Inspector** | top-right, inset 20 | 320 × `calc(100% − 40px)` | only while exactly one node or edge is selected |
| **Mode pill** | bottom-centre, inset 20 | auto × 36 | always |
| **View controls** | bottom-right, inset 20 | **168** × 36 | always; 40% after 2 s idle, full on hover |
| *Layer legend* | bottom-left, inset 20 | 148 × auto | **conditional** — only while ≥ 1 observed edge exists |

Changes: inset 16 → 20; chip height 40 → 44 (it now carries two lines of information);
view controls 132 → 168 to take the theme toggle; the minimap toggle `▣` moves out of
permanent chrome into ⌘K.

**Z-order** (unchanged): grid → configured edges → observed edges → nodes → handles →
connection preview → floating panels → popovers/palette → conflict bar → the one dialog.

Still no status bar, no breadcrumb, no toolbar, no menu bar, no tab bar. Everything else is
⌘K or a context menu.

---

## 4. Library — amended

Three groups in ARCHITECTURE §5's order: detected harnesses, endpoints, role presets. Row
rhythm tightens: 40 px rows, **6 px** between rows (was 8), 12 px row padding, 20 px panel
padding, `micro` section headers with a right-aligned count.

Row hover fill becomes **`accent-tint`** (was `iris`/6%) — a token, not an opacity guess, so
it lands identically in both themes.

### 4.0 Loading — new

`GET /api/harnesses` is a `PATH` scan. Until it resolves the panel shows **three 40 px
skeleton rows** per group: an `accent-tint` monogram square and two `hairline` bars at 40%
and 60% width, cross-fading between 40% and 70% opacity over 1200 ms `ease-in-out`. No
spinner — a spinner in a list is a smaller lie than a shape that becomes the thing.

Under reduced motion the skeletons are static at 55%.

If the request **fails** (daemon reachable but the endpoint errored) the detected group
shows the §16 inline error block with `[ Retry ]`. If the daemon is unreachable, §16's
transport bar owns it and the Library shows the same skeletons frozen at 40% — one failure,
one message.

### 4.1 Row anatomy — unchanged in behaviour

`[monogram] · name (body/500) · subtitle (mono-sm, ink-2, middle-truncated for paths) ·
drag affordance (⠿, ink-3, 0 → 60% on hover)`. Rows remain **drag sources only** — clicking
does not select and does not open anything. Full detail is a 500 ms hover tooltip.

### 4.2 / 4.3 / 4.4 — unchanged

Not-installed disclosure, the three per-group empty states with the search-path disclosure,
and the 48 px collapsed rail all stand as specified, retokenised (`copper` → `accent`).

### 4.5 Drag to instantiate — one addition

Steps 1–5 unchanged, including the deliberate empty `role` and `model` and the
first-drop-sets-`entrypoint` rule.

**Addition — the drop target is now legible before the drop.** While a Library drag is in
flight the canvas dims its dot grid to 60% and draws a 1 px `accent` @ 25% inset border
around the whole canvas region. Currently the only feedback that a drag will succeed is the
ghost node itself, which sits under the cursor where the operator is not looking. This is
one border and it removes the "will it take?" hesitation.

---

## 5. The agent node — amended

> **As built, 2026-09-16.** Both canvases now draw one card. Build and Run ("Full trace") render
> the same `.build-node` agent card from [`BuildNodeCard.tsx`](../ui/src/components/canvas/BuildNodeCard.tsx);
> a run layers its projected task state, spend and evidence routes under the identity row rather
> than substituting a card of its own. The `.node` anatomy specified below is no longer rendered on
> either canvas. Everything it says about *what an agent card must state* still holds — only the
> box it is stated in changed.

### 5.1 Anatomy — 276 × 96

```
 ┌╥──────────────────────────────────────────────────────┐
 │║                                                      │
 │║  ⌾   Protocol Researcher                  ENTRY  ◐   │  ← 18px role glyph in a 2px
 │║      Research ACP behaviour                          │    accent ring (entrypoint)
 │║                                                      │  · name  node/15/550
 │║ ──────────────────────────────────────────────────── │  · role  meta/12/ink-2
 │║  [Oc]  kimi-for-…/k3-256k                    $5.00   │  · model mono-sm · budget mono-sm
 │║  ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  │  ← 3px budget lane (Phase 05)
 └╨──────────────────────────────────────────────────────┘
  ▲
  3px status rail, full status colour, lg radius on the left corners only
```

| | v1 | v2 | Why |
|---|---|---|---|
| Size | 264 × 88 | **276 × 96** | the meta row and the name were 8 px apart; the budget lane had no home |
| Name | `body` 14/400–500 | **`node` 15/550** | it is the product's most important string and shared a step with an inspector label |
| Role glyph | 20 px | 18 px | balances against the larger name |
| Budget lane | "reserve 4 px" | **3 px lane, always rendered** | rendered as an empty `hairline` track in Phase 04 and filled in Phase 05, so the geometry never changes |
| Internal padding | 12 | 14 top/bottom, 14 side | 96 − (14 + 20 + 1 + 20 + 3 + 14) balances |

Everything else is unchanged: name truncates at the tail, `id` is never on the node, model
middle-truncates, empty role renders `Add a role` in `ink-3` italic, the `ENTRY` `micro`
pill sits left of the status indicator, `allowRecruiting: false` adds a 12 px `Lock` glyph
at the meta row's left.

**Budget lane detail** (so Phase 05 does not redesign it): `hairline` track, filled
left-to-right to `spent / limitUsd` in `accent-dim`, crossing to `accent` past
`warnAtPercent`, `alert` at or past the limit. In Phase 04 the track renders empty. Colour
is not the only channel — the fill width is the primary signal.

### 5.2 States — amended

| State | Treatment |
|---|---|
| default | 1 px `hairline`, no shadow |
| hover | `hairline` → `ink-3` @ 40%, `e1` shadow, handles grow 8 → 12 px and take `accent` |
| selected | **2 px `accent` ring at 3 px offset**, `e1`, inspector opens |
| multi-selected | same ring at 60%, no inspector (inspector shows "n selected" + delete / align) |
| keyboard-focused | 2 px `accent` ring **plus** a 1 px `panel-solid` inner ring, so it reads over any fill |
| incomplete | **1 px `accent` border + `accent` dot, top-left** — required field never filled |
| invalid | 1.5 px `alert` border + `alert` dot, top-left; tooltip names the failing rule from TEAM_CONFIG.md |
| dragging | 0.85 opacity, `e2`, grid-snapped |
| `running` / `starting` (live run) | runtime-only 2 px `live` perimeter and visible task row; the validity dot remains independently visible, and no runtime treatment serializes to YAML |
| `done` / `error` / `cancelled` / `offline` | semantic perimeter plus glyph, state word, and preserved task title; colour is redundant, never the only channel |

The incomplete/invalid split is new on the node and mirrors the inspector's two validation
weights (CANVAS_SPEC §5.4), which previously had no node-level distinction.

### 5.3 Status indicator — see DESIGN_LANGUAGE §12

Same eight states and shapes, retokenised. `starting` / `running` use `live` blue;
`waiting` uses neutral `halt`. Task lifecycle labels are specified in
TNG89_INTERACTION §11 and remain separate from run/result lifecycle labels.

### 5.4 Inspector — re-zoned

Same principle: **inspector, not inline**, with the two inline exceptions (name and role by
double-click, `Enter` on a selected node, `Esc` reverts, blur commits). What changes is the
order and the grouping, because a flat list of eight fields has no hierarchy.

```
┌─ INSPECTOR ─────────────────── × ─┐
│                                   │
│  ⌾  Protocol Researcher           │  title/19, editable on click
│     researcher                    │  mono, ink-2 — the `id`
│     ◐ idle                        │  micro + status shape
│                                   │
│  IDENTITY ─────────────────────   │  micro header, hairline rule
│  Role                             │
│  ┌─────────────────────────────┐  │
│  │ Research ACP behaviour      │  │
│  └─────────────────────────────┘  │
│  Model                            │
│  ┌─────────────────────────────┐  │
│  │ kimi-for-coding/k3-256k   ⌄ │  │  free text; suggestions only if a
│  └─────────────────────────────┘  │  harness advertises models (§15.3)
│                                   │
│  BEHAVIOUR ────────────────────   │
│  ◉ Entry point for this team      │
│    Receives the goal first        │  meta, ink-3
│  ☑ May recruit helpers            │
│                                   │
│  Budget                           │
│  ┌────────────┐ ┌──────────────┐  │
│  │ $ 5.00     │ │ warn at 80 % │  │
│  └────────────┘ └──────────────┘  │
│  ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  $0.00 spent    │  Phase 05; hairline track in 04
│                                   │
│  ▸ PROCESS ────────────────────   │  collapsed by default
│    cmd   opencode                 │
│    args  acp                      │
│    cwd   .                        │
│    env   —                        │
│                                   │
│  ─────────────────────────────    │
│  Save as preset       Delete      │  ui/13 ink-2; Delete → alert on hover
└───────────────────────────────────┘
```

Three zones, in the order the operator actually thinks:

- **IDENTITY** — `role`, `model`. The two fields a fresh node is deliberately missing
  (CANVAS_SPEC §4.5), first, above the fold, because they are what stands between a drop and
  a valid save.
- **BEHAVIOUR** — entrypoint, recruiting, budget. What the agent is *allowed* to do.
  *Superseded 2026-10-02 by **CONTEXT** — what the agent is given: its place in the team, the
  Brief, and everything connected to it. See
  [ADR 0034](decisions/0034-agent-context-and-team-orientation.md).*
- **PROCESS** — `spawn.cmd/args/cwd/env`. Collapsed, read-only 4-line summary when closed.
  Renamed from `SPAWN` because "process" is what it means to someone who has not read the
  ACP spec, and the field labels inside are still the schema's names.

Unchanged from CANVAS_SPEC §5.4 and restated so the folding-in is lossless: live per-field
validation against `GET /api/config/schema` plus the TEAM_CONFIG.md semantic rules; the two
weights (incomplete → `accent` border + `Required`; error → `alert` border + message); a
field never turns red while being typed in, only on blur or ⌘S; the credential-shaped env
key warning that does not block; entrypoint radio-like in both directions with the inert
checked box and its hover explanation; the entrypoint-deletion rules; every edit immediate
in memory with no Apply button; `Esc` closes without reverting; deselect closes with a
`quick` slide.

**One addition — the status line under the id.** A `micro` status shape + word, so the
inspector answers "what is this doing" without the operator going back to the node they just
covered with the inspector. In Phase 04 it always reads `idle`.

### 5.5 Level of detail — thresholds unchanged, sizes updated

| Zoom | Render |
|---|---|
| ≥ 0.6 | full (§5.1) |
| 0.35 – 0.6 | 276 × 48: status rail, role glyph, name, status indicator. Role, meta row and budget lane hidden. |
| < 0.35 | 48 × 48 chip: role glyph on the status-rail colour, name beneath at `micro` |

Transitions between levels stay instantaneous. Animating at low zoom while panning is where
a canvas starts dropping frames.

---

## 6. Edges — amended

§§6.1–6.6 are unchanged in behaviour and retokenised by DESIGN_LANGUAGE §13: the
four-channel separation, the visual table, the coincidence shuttle, multiplicity and ageing,
the derivation from the frozen wire schema, and drawing / refusal / typing / deleting /
reconnecting. The observed layer is still built in Phase 04 against **fixture events in the
WEBSOCKET_SCHEMA shape** so Phase 05 only connects the socket.

Two additions.

### 6.7 Layer legend and layer solo — new

**Legend.** A 148 px `e1` block, bottom-left, inset 20, that exists **only while at least one
observed edge exists.** Two rows, `micro` labels, live counts:

```
┌──────────────────────┐
│ ───────  Configured 3│   warp swatch: 1.5px solid
│ ┄┄┄▸     Observed  ×4│   accent swatch: travelling dash
└──────────────────────┘
```

Clicking a row **solos** that layer. Clicking it again restores both. The soloed row takes a
1 px `accent` border; the other row drops to `ink-3`.

**Solo, keyboard `L`.** Cycles `both → configured only → observed only → both`. The mode is
announced politely and shown in the legend; it is **view state, never document state** — it
does not dirty the document, is not persisted to the team file, and resets to `both` on
load.

Why this earns its 148 px: ARCHITECTURE §5 makes distinguishing the layers a named
requirement, and the honest answer for a graph with ten nodes and thirty observed events is
that stroke and colour get you *most* of the way and an off switch gets you the rest. It is
also the cheapest possible answer to "did the run follow the design?" — solo configured,
solo observed, compare. And it is conditional chrome: on a Phase 04 canvas with no run, it
is not there.

### 6.8 Anomaly emphasis — clarified

An observed edge in pipeline mode with no configured counterpart is an anomaly
(ARCHITECTURE §4). v1 gave it `copper` + a ⚠ midpoint badge. v2 gives it **`alert`**, and
adds one thing: the anomaly also raises a `micro` `alert` count on the mode pill
(`⇉ Pipeline · 3 steps · ⚠ 1`), because an anomaly is a statement about the *design* and the
mode pill is where the design is explained. Clicking it selects the first anomalous edge.

In team mode there is no configured graph to deviate from, so nothing is anomalous and all
observed edges are gold. Unchanged.

---

## 7. Canvas mechanics — unchanged

Navigation, zoom range 0.25–2.0, fit / fit-selection / reset, `snapGrid [8,8]`, marquee
multi-select, 1 px `accent` alignment guides within 4 px, `+24,+24` collision offset,
`⌥⌘L` dagre auto-layout, deterministic seeded layout when no positions exist, dot grid
`gap 16 size 1` in `ground-dot`, minimap off by default.

One change: the minimap toggle moves from the view controls into ⌘K (§3), so the view
controls can carry the theme toggle without growing past 168 px.

**§7.3 node-position persistence remains the open operator decision** — sidecar
`<team>.layout.json` (recommended), an `Agent.ui` schema addition, or `localStorage`. Not
decided here; it is a schema/backend call (§17).

---

## 8. Execution modes — amended in one place

The mode pill, both canvas states, the switch-is-an-event sequence and the last-edge inline
confirmation all stand as CANVAS_SPEC §8 specifies them, retokenised (`iris` → `accent`).

**Addition:** the pill gains the conditional anomaly count from §6.8, and the reserved 36 px
run-control slot on its right end stays reserved and disabled with the tooltip *"Running a
team arrives in a later phase."* — CANVAS_SPEC §14, restated because the pill's geometry
changed and the slot must survive the change.

---

## 9. YAML round-trip — the two biggest changes in this document

Principle 4: the canvas is a view over a file, and the file is the truth (ARCHITECTURE §5).
v1 expressed that with a chip that said "Unsaved changes" in grey. v2 makes the file a
first-class object you can *see, switch and write*.

### 9.1 The document switcher

Top-centre, **44 px**, two lines when it has two things to say. It is the single place file
state is expressed, and it is now also the way you reach another file.

```
   clean                              dirty
┌───────────────────────────────┐  ┌────────────────────────────────────┐
│ ○ research-team.yaml       ⌄  │  │ ◆ research-team.yaml            ⌄  │
│   ~/.loomwatch/teams          │  │   3 lines differ    [ Save ⌘S ]    │
└───────────────────────────────┘  └────────────────────────────────────┘
  ink-3 hollow dot                   accent diamond · accent-fill button
```

Eight states. Seven are CANVAS_SPEC §9.1's, retokenised; the second line is new and the
`dirty` state's text changes.

| State | Dot | Line 1 | Line 2 / right slot |
|---|---|---|---|
| clean | `ink-3` hollow ring | `research-team.yaml` | abbreviated directory, `meta` `ink-3`; `⌘S` hint on hover |
| **dirty** | `accent` diamond | `research-team.yaml` | **`n lines differ`** + `[ Save ⌘S ]` in `accent-fill` |
| saving | `accent` arc, rotating | `Saving…` | the ledger sweep (below) |
| saved | `ok` check | `Saved` | reverts to clean after 2 s |
| failed | `alert` × | `Couldn't save` | `[ Retry ]`, reason on click |
| incomplete | `accent` diamond | `1 thing to finish` | `[ Review ]` → problems popover |
| invalid | `alert` filled | `2 problems` | `[ Review ]` → problems popover |
| read-only | `halt` lock | `research-team.yaml` | `Read-only`, reason on click |
| new | `accent` hollow diamond | `research-team.yaml` | `Not saved yet` + disabled `Save` |

**`n lines differ` replaces "Unsaved changes".** `TeamFileModel` already holds the loaded
YAML string and the current document, so a line-diff count is available client-side with no
backend work and no new dependency. "Unsaved changes" tells the operator a state; "3 lines
differ" tells them a *magnitude*, which is what decides whether they save or look first. It
is also the honest framing for a version-controlled file: the unit of truth is a line in a
diff.

**The chevron makes it a switcher.** Clicking anywhere on the chip opens an `e2` popover:

```
┌──────────────────────────────────────────────┐
│ ⌕ Filter teams                               │
│ ────────────────────────────────────────────  │
│  ◆ research-team.yaml            3 differ    │  current, accent-tint row
│    review-pipeline.yaml                      │
│    nested/spike.yml                          │
│ ────────────────────────────────────────────  │
│  + New team…                          ⌘N     │
│ ────────────────────────────────────────────  │
│  /Users/me/.loomwatch/teams/research-team.…  │  mono, ink-3
│  Copy path      Reload from disk    Discard  │  ui/13; Discard → alert
│  Saves keep your comments and key order.     │  meta, ink-3
└──────────────────────────────────────────────┘
```

The list is `GET /api/teams` — `{root, files}`, already shipped in TNG-74, lexicographically
sorted `/`-separated paths confined below `root`. The UI forms `{root}/{file}` and navigates
by `?path=`, which is exactly what `GET /api/team` already requires. **This needs no new
endpoint.** ↑↓/Enter to choose; switching a dirty document asks inline on the row —
`Save first?` / `Discard` / `Cancel` — and never silently drops work.

`Copy path` stays the honest replacement for Reveal in Finder; a browser cannot do the
latter (CANVAS_SPEC §15.6).

### 9.1a The ledger sweep — making the write visible

Saving is the moment the canvas stops being the truth and the file starts. It gets 900 ms of
`settle` motion and nothing else in the product gets this treatment:

1. On ⌘S the `Save` button's `accent-fill` collapses into a 2 px `accent` line along the
   chip's bottom edge (160 ms).
2. That line **sweeps left → right** across the chip's full width (900 ms `settle`) — the
   thread being laid into the file.
3. On the `PUT /api/team` 200 the line snaps to `ok` and the dot becomes an `ok` check;
   `Saved` holds 2 s, then the chip returns to clean and the line dissolves.
4. On a non-2xx the line snaps to `alert` and stops where it was; the chip enters `failed`
   with the server's message verbatim (a `422` the client did not predict is a client bug —
   surface it, never swallow it).

Under reduced motion: no sweep. The line appears full-width in `accent` for 160 ms, then
resolves to `ok` or `alert`. The state change is never *only* motion — the dot, the word and
the colour all change too.

Still: **no autosave, no save-on-blur, no debounce-write.** ⌘S from anywhere including a
focused input. `Save` is disabled while the document is invalid or incomplete, with the
reason on hover.

### 9.2 Validation — now navigable

Same gate as CANVAS_SPEC §9.2: validate against the daemon's `GET /api/config/schema`
(fetched once, never bundled — a bundled copy is a second source of truth that drifts from
the daemon that will reject the save), then the TEAM_CONFIG.md semantic rules; `PUT` re-validates
server-side, so client validation is a courtesy that explains the problem next to the field
rather than after a round-trip.

Three additions:

- **The popover separates the two weights.** `n to finish` (`accent`, incomplete) above
  `n problems` (`alert`, errors), each row naming the node or edge and the rule.
- **`F8` / `⇧F8` cycles problems.** Selects, centres and focuses the offending field —
  next / previous. The gap in v1 was that the save was blocked and the only route to the
  cause was to guess which node.
- **The blocked `Save` says which.** Hover reason becomes the first problem verbatim plus
  `and n more`, not a generic "document is invalid".

### 9.3 External change — unchanged

Hash the loaded `yaml`, re-`GET` on window focus and immediately before a save, compare.
Clean → silent reload + a 3 s `Reloaded from disk` chip; positions preserved for agents that
still exist. Dirty → the `alert` conflict bar with `Compare…` / `Keep mine` / `Use disk`,
the read-only unified diff sheet, the inline confirm on `Use disk`, and **LoomWatch never
merges**. File deleted or renamed → canvas stays, goes read-only, chip reads `File is gone`
with `Save a copy…`.

The detection mechanism stays behind one function so the push channel can be swapped in
(§17).

### 9.4 / 9.5 — unchanged

The reformat modal stays **withdrawn** — `TeamFileModel` is CST-preserving and
`PUT /api/team` writes verbatim bytes, so comments and key order survive; the chip popover
carries the one `meta` line instead, and `Show YAML` is the checkable version of the claim.
Structural edits still move comments and the diff is the disclosure. Unsupported
`schemaVersion` → read-only with a `halt` bar. An unparseable file → the product's **only**
modal.

---

## 10. First run and empty states — retuned

### 10.1 No team file open

Same architecture — full-bleed canvas, one centred composition, one action, no Library, no
chip, no mode pill. What changes is the typography and one line of copy.

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│                                                                   │
│                         ╱╲  ╱╲  ╱╲                                │  woven mark
│                         ╲╱  ╲╱  ╲╱                                │  44px, accent
│                                                                   │
│                         LoomWatch                                 │  display/34 serif
│                                                                   │
│              Compose a team of agents. Watch them work.           │  body, ink-2
│                                                                   │
│                    ┌────────────────────────┐                     │
│                    │       New team         │                     │  accent-fill, 44px
│                    └────────────────────────┘                     │  ← the one gold fill
│                                                                   │
│                    or open an existing team                       │  ui/13, accent link
│                                                                   │
│                                                                   │
│  ◆ 3 harnesses ready                                    ◐   ⌘K    │  meta, ink-3
└───────────────────────────────────────────────────────────────────┘
```

- `display` is the serif at 34 px (DESIGN_LANGUAGE §6). This screen is the only place it
  appears and it is the reason the face is worth one file.
- **`or open an existing team` now opens §9.1's switcher popover** anchored to the link,
  instead of being a link with nowhere to go. This is the fix for "the operator's own files
  are unreachable" arriving on the very first screen.
- The **theme toggle appears in the bottom-right** even here, beside the `⌘K` hint. It is the
  first screen and the board asked for a discoverable toggle; a toggle you cannot find until
  you have opened a file is not discoverable.
- Bottom-left status stays the single most valuable line on the screen:
  `3 harnesses ready`, or — the case that matters — `No agent harnesses found`, clickable to
  the same search-path disclosure as §4.3.
- Entrance: the mark fades and scales 0.96 → 1 over `entrance`; the headline, subhead and
  button follow at 60 ms stagger; nothing translates more than 8 px.

**No wizard, no tour, no sample gallery, no checklist.** One button.

### 10.2 Creating a team — unchanged

`New team` replaces the headline in place with a single pre-focused borderless input; the
slugified filename and destination render live beneath in mono; `Enter` creates the
**document, not the file**; `Esc` returns. The chip opens in `new`, `Save` disabled with
*"A team needs at least one agent."*, Library and mode pill fade in over `entrance`, the
§10.3 ghost is centred. Filling the first agent's `role` and `model` enables `Save`; ⌘S
writes the file through the existing create-on-save `PUT /api/team`.

### 10.3 / 10.4 — unchanged

The 276 × 96 dashed ghost node (resized to match §5.1) that brightens to `accent` @ 40%
during a drag and never returns after the first drop; the one-time 6 s
*"Drag from the right edge of a node to sequence another after it."* line. That is the
entire onboarding.

---

## 11. Keyboard and the command palette — amended

⌘K remains the menu. Palette unchanged in form: `e2`, 560 px, centred, 22% from the top, a
filter field and a flat **ungrouped** ranked list, each row icon + label + shortcut in mono.

**Actions list** — additions in bold: `Add agent…`, `Save`, `Open team…`, `New team…`,
`Reload from disk`, `Discard changes`, `Fit view`, `Auto-layout`, `Toggle library`,
**`Toggle minimap`** (moved in from the view controls), `Switch to dark / light`,
**`Follow system appearance`**, **`Solo configured edges`**, **`Solo observed edges`**,
**`Next problem`**, `Copy file path`, `Show YAML`.

| Key | Action |
|---|---|
| `⌘K` | command palette |
| `⌘S` | save |
| `⌘Z` / `⇧⌘Z` | undo / redo (in-memory; saving does not clear the stack) |
| `⌘\` | toggle Library |
| **`⌘P`** | **open the document switcher** |
| **`⌘N`** | **new team** |
| **`L`** | **cycle edge-layer solo** |
| **`F8` / `⇧F8`** | **next / previous problem** |
| **`⌘⇧L`** | **toggle theme** |
| `Esc` | dismiss popover → deselect → close inspector, in that order |
| `Delete` / `Backspace` | delete selection (nodes with edges take an inline confirm) |
| `Enter` | rename selected node · commit an inline edit |
| `Tab` / `⇧Tab` | cycle nodes in `pipeline_order()`, else creation order; scrolls into view |
| `F` / `⇧F` / `⌘0` | fit · fit selection · reset zoom |
| `⌥⌘L` | auto-layout |
| `⌘+` / `⌘−` | zoom |

`Show YAML` stays a read-only syntax-highlighted sheet of exactly what would be written —
the escape hatch that makes the file-is-truth claim checkable at any moment.

Every primary flow — create a team, open a team, add an agent, connect two agents, fix a
problem, save, switch theme — is reachable without a pointer. That is now true of the two
new flows as well, which is the condition on adding them.

---

## 12. Accessibility — amended

CANVAS_SPEC §12 stands in full. Restated with what v2 adds:

- **Contrast is verified, not deferred.** DESIGN_LANGUAGE §4 carries computed ratios for
  every token pair; §16 requires the built app to match them to ±0.05.
- Visible focus on every interactive element: 2 px `accent` at 2 px offset, plus the
  `panel-solid` inner ring on nodes.
- The canvas is a labelled `application` region. Node accessible name
  `"<name>, <role>, <model>, <status>"`; edge, `"sequence from <a> to <b>"`; observed edge,
  `"<kind> observed from <a> to <b>, <n> times"`. React Flow's `nodesFocusable` /
  `edgesFocusable` cover traversal.
- **Live regions.** Polite: status changes, mode changes, save results, validation counts,
  `Reloaded from disk`, layer-solo changes, theme changes. Assertive: guard rejections, disk
  conflicts, save failures, the parse error. Unchanged in policy; the new surfaces are
  assigned here so they are not forgotten.
- Hit targets ≥ 32 px; edge hit area 12 px regardless of stroke. The theme toggle is a
  32 px button inside the 36 px cluster.
- **Colour is never the only channel** — and v2 leans on this harder because the palette is
  smaller. `running` is blue with a filled dot, visible word, task title, and optional
  breathing perimeter; `waiting` is neutral with a static hollow diamond and `QUEUED`.
  Incomplete vs invalid differ in hue *and* dot glyph; the two edge layers differ in four
  channels.
- **The theme toggle is not a `prefers-color-scheme` override only** — `system` remains a
  first-class third state so an operator whose OS switches at sunset is not fighting a
  sticky choice.
- Reduced motion: DESIGN_LANGUAGE §10.
- **TNG-115 activation contract.** Agent nodes and live-activity cards are native buttons.
  The structured terminal Response uses equivalent button semantics: click, `Enter`, and
  `Space` share one action and Space prevents scrolling. `aria-expanded` names inspector /
  provenance state. Dismissing a panel or popover restores its trigger; collapsing an
  entity/category restores its owner; Back to response restores the terminal Response.
- Informational surfaces are not controls: the standalone mode display no longer exposes a
  button role. The document chip is now a group with separate native Open and Save/Review
  buttons, avoiding nested or composite button semantics.

---

## 13. Window sizes — TNG-115 amendment

≥ 1280 keeps the authored canvas composition · 1024–1280 inspector overlays the canvas
edge · 768–1024 Library and inspector become scrimmed overlay sheets, only one open at a
time · < 768 becomes an intentional single-column **Command / Inspect** composition.

The earlier `< 768 view-only` rule is withdrawn for the approval candidate: it hid the
prompt-to-response flow that TNG-89 requires the design to prove. Narrow mode preserves
configuration inspection, prompt submission, automatic activity, response/provenance
selection, filtering, theme switching, and the error/cancel/retry demonstrations. The
desktop coordinate graph is reprioritized into document → configured agents → runtime
content → viewport-docked composer; library and edge geometry are suppressed while their labels,
ownership, ordering, statuses, and capture words remain in the card sequence. Text does not
scale, and interactive targets are at least 44 px.

Below 1024 the view-control cluster drops the zoom buttons (pinch and `⌘±` still work) and
keeps the theme toggle, so it survives every breakpoint. Below 768 the layer legend is
hidden; the solo cycle stays on `L` and in ⌘K.

Height below 600: mode pill and view controls merge into one bottom-right cluster, and the
layer legend is suppressed.

---

## 16. State matrix — new section

CANVAS_SPEC has empty states and no loading or transport-failure states. This is the gap
that shows up on day one of real use, because the daemon is a local process that can die.

| Condition | Surface | Treatment |
|---|---|---|
| **Boot, before first paint of data** | canvas | dot grid only, chip and panels in `e1` with skeleton contents. No spinner, no logo screen. ≤ 400 ms in the normal case, so it must look like the app, not like a loader. |
| **Harnesses loading** | Library | §4.0 skeleton rows |
| **Harnesses failed** | Library, detected group | inline block: `alert` 1 px dashed `md` box, `Couldn't read the harness list.`, server message in `mono-sm`, `[ Retry ]` |
| **Team file loading** | canvas | ghost node silhouette at 40% + chip in `saving`-style arc with `Opening…`. Nodes fade in over `quick` when parsed. |
| **Team file parse failure** | modal | the product's **only** modal (§9.5): the error, the offending line in `mono`, `Open another team…` |
| **Daemon unreachable** | full-width bar, top, `halt` | `LoomWatch can't reach the daemon.` + `Retrying in 3s…` + `[ Retry now ]`. The canvas **stays interactive and read-only-safe**: pan, zoom and inspect keep working on the in-memory document; `Save` disables with the reason. Never a blank page and never a lost in-memory document. |
| **Daemon returns** | same bar | collapses to a 2 s `ok` `Reconnected` chip, then goes. If the file changed while disconnected, §9.3's conflict flow takes over. |
| **WebSocket dropped (Phase 05)** | mode pill | `micro` `halt` `live feed lost` on the pill, reconnect with backoff. Observed edges freeze at `accent-dim` rather than disappearing — vanishing edges would read as "the run ended". |
| **Save in flight** | chip | §9.1a ledger sweep; the canvas stays fully interactive (the write is atomic server-side; blocking the UI would be theatre) |
| **Save rejected `422`** | chip + popover | `failed` state, server message verbatim, `[ Review ]` opens problems |
| **Read-only (`schemaVersion`)** | `halt` bar | persistent, editing disabled, pan/inspect allowed |
| **Empty: no file open** | canvas | §10.1 |
| **Empty: file open, no agents** | canvas | §10.3 ghost node |
| **Empty: a Library group** | Library | §4.3, one per group |
| **Empty: no harnesses at all** | Library + first run | the search-path disclosure — the most likely first-run failure, and it must name the cause |

Two rules that hold across every row: **an error always carries the server's own message
verbatim** — LoomWatch never paraphrases a daemon error into something friendlier and less
diagnostic; and **no error state destroys the in-memory document.** The operator's unsaved
graph survives every failure in this table.

---

## 17. Open decisions and escalations

Unchanged from CANVAS_SPEC §15 except where noted. Nothing in this document decides any of
them.

**Already shipped, so nobody asks twice:** `GET /api/harnesses`, `GET /api/teams`,
`GET /api/team?path=`, `PUT /api/team` (validates, `422`, `atomic_write`, verbatim bytes,
create-on-save), `GET /api/config/schema`.

1. **Node layout persistence** (CANVAS_SPEC §7.3) — sidecar `<team>.layout.json`
   recommended; alternatives are an `Agent.ui` schema change or `localStorage`. Schema /
   backend call. *Blocks:* position persistence only; deterministic seeded auto-layout ships
   regardless.
2. **Configured edge `kind`** — the schema pins configured edges to `sequence`. Following the
   schema; the vocabulary for the other three kinds exists but the picker stays dormant.
   Opening it is a schema change + ADR. *Blocks:* nothing today.
3. **Library data sources** — endpoints and presets have no backend
   (`GET|POST /api/endpoints`, `/api/presets`, plus where they persist — proposal
   `~/.loomwatch/library.yaml`, its own schema and ADR). Additive asks on `/api/harnesses`:
   return not-installed harnesses with `available: false` so §4.2 stops being a client-side
   constant, return the searched `PATH` so §4.3 can show it, and `models: string[]` if it is
   knowable. *Blocks:* two of three Library groups ship empty against fixtures.
4. **Config change notification — ESCALATION.** §9.3 currently focus-polls and hashes.
   Making it correct wants an `etag` on `GET /api/team` + `If-Match` on `PUT` (which also
   closes the two-tab lost-update window) and a push channel. **A push channel touches the
   frozen WebSocket schema** — a message that is not a `RunEvent` cannot go down that socket
   without an ADR (WEBSOCKET_SCHEMA §1). Proposal: a separate `/api/config/events` SSE
   stream, leaving the frozen socket untouched. Escalated to Chief Secretary, per the
   frozen-schema boundary; **not decided here.**
5. **Reveal in Finder** — a browser cannot. Copy-path for v1. *Blocks:* nothing.
6. **React Flow attribution** — xyflow is MIT and requires the watermark bottom-right unless
   Pro is licensed. It now collides with a **168 px** view-control cluster, not 132.
   Either keep it and move the cluster left by 96 px, or licence Pro. A money call.
   *Blocks:* the bottom-right layout.
7. **New: the third font.** `@fontsource/instrument-serif` (400, latin, ~18 KB) for the
   `display` step, used on two strings. A build-dependency call with a specified fallback
   (Inter 600 / −0.03em) that changes nothing else. *Blocks:* nothing.

---

## 18. Build order, if approved

The redesign is a re-skin plus five new components. Ordered so each step is independently
reviewable and the app is never broken between steps.

| # | Work | Touches |
|---|---|---|
| 1 | Token layer: the three tiers, both themes, the theme class + no-flash inline script, `theme-color` meta, reduced-motion wiring | `ui/index.html`, `ui/src/index.css` |
| 2 | Mechanical rename pass, v1 → v2 tokens (DESIGN_LANGUAGE §14), plus the §16.4 no-hex check | all of `ui/src/components` |
| 3 | Typography: the three fontsource packages, the nine steps, `tabular-nums` | `index.css` |
| 4 | Theme toggle in the view controls + ⌘K entries + `⌘⇧L` + the sweep | view controls, palette |
| 5 | Node re-proportion: 276 × 96, the `node` type step, the budget lane, incomplete vs invalid states, the three LODs | `agentNode` |
| 6 | Elevation and motion pass: `e1`/`e2` per theme, rim light, bloom, the seven durations | shared panel primitive |
| 7 | Document switcher: the eight chip states, the `n lines differ` count, the `GET /api/teams` popover, the ledger sweep | chip + a new popover |
| 8 | Inspector re-zoning into Identity / Behaviour / Process + the status line | inspector |
| 9 | Problems: two weights in the popover, `F8` cycle, the specific blocked-save reason | validation surface |
| 10 | Layer legend + solo (`L`) + the mode-pill anomaly count | canvas, mode pill |
| 11 | State matrix (§16): skeletons, the daemon-unreachable bar, retry and reconnect | shell |
| 12 | First run: serif display, the switcher on `open an existing team`, the toggle, the staggered entrance | first-run |

Steps 1–3 are the shared token layer the board asked for and are worth landing on their own,
because every later step depends on them and nothing depends on them being landed together
with a visual change.
