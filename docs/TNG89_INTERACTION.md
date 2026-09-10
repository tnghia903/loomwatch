# LoomWatch — TNG-89 interaction spec

Prompt-to-run, live response landing, and the expandable provenance graph, expressed in the
"Obsidian & Gilt" design language.

- **Extends:** [`DESIGN_LANGUAGE.md`](DESIGN_LANGUAGE.md) (visual language),
  [`UX_REDESIGN.md`](UX_REDESIGN.md) + [`CANVAS_SPEC.md`](CANVAS_SPEC.md) (the canvas).
- **Consumes, never decides:** [`decisions/0005-run-control-and-companion-provenance-channel.md`](decisions/0005-run-control-and-companion-provenance-channel.md)
  and [`RUN_PROVENANCE_CONTRACT.md`](RUN_PROVENANCE_CONTRACT.md). Every state, entity kind,
  edge kind, capture value and coverage level below is taken from that contract verbatim.
  Where this document and the contract disagree, **the contract wins** and this document is
  the bug.
- **Prototype:** [`mockups/prototype.html`](mockups/prototype.html) screens 10–13.
- **Pending §13 — read before starting TNG-121:**
  [`TNG121_EDITABLE_PIPELINE.md`](TNG121_EDITABLE_PIPELINE.md) specs the editable live
  pipeline (drag/keyboard agent insertion) and the node + history overflow fixes that answer
  the 2026-09-10 board rejection. It is drafted to be folded in here as §13; do not maintain
  two normative specs.
- **Status:** design only. No production UI code. Gate B must be accepted before
  implementation (TNG-89A).

---

## 0. The one idea

The canvas already separated **structure** from **activity** in its edges: configured edges
are a quiet grey solid line (warp), observed edges are a travelling gold dashed line
(weft) — `DESIGN_LANGUAGE §13`, an `ARCHITECTURE §5` requirement.

TNG-89 adds nodes that are not configuration. So the same law extends to nodes:

> **If it is filled and bordered, it is in the file.
> If it is tinted and ringed, it came from a run.**

| | Configuration node | Runtime node |
|---|---|---|
| Examples | Agent | Goal, Response, provenance entities |
| Fill | `panel-solid` — opaque material | `accent-tint` / none — light on the ground |
| Border | 1 px `hairline` | 1 px `accent` (or the capture treatment, §5) |
| Written to YAML | yes, including position | **never** |
| Moves on run | never | laid out deterministically, §4.1 |

This is not decoration. `TNG-89E`/`TNG-89F` both require that a run never mutates YAML or
moves saved positions; making that a *visible material distinction* is how the operator can
trust it without reading the file.

**Z-order** inserts one layer into `UX_REDESIGN §3`'s stack:

```
grid → configured edges → observed edges → configuration nodes
     → RUNTIME OVERLAY (provenance edges → runtime nodes)
     → handles → floating panels → popovers → bars → the one dialog
```

---

## 1. The prompt composer

Bottom-centre, `e1`, **720 × 56** collapsed, inset 20. It absorbs the mode pill.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⇉ Pipeline · 3 steps │ What should the team do?              [ Run  ⌘↵ ]    │
└──────────────────────────────────────────────────────────────────────────────┘
  mode chip            │ input                                  primary action
  (was the mode pill)  1px hairline divider
```

**Why the mode pill moves inside it.** The pill explains how the document will execute
(`CANVAS_SPEC §8.1`). That fact is most valuable at the moment you are about to execute it,
not parked in the corner. It keeps its popover and its click target; it loses its own
panel. The reserved 36 px run slot of `CANVAS_SPEC §14` is now spent — that is what it was
reserved for.

**Bottom-offset variable.** `CANVAS_SPEC §14` reserves the bottom edge for the phase-05
timeline scrubber (64 px dock). The composer, mode chip and view controls all position from
`--lw-bottom-offset`, not a constant. Scrubber open → offset +72 px, composer translates
up over `move`.

### 1.1 Geometry and growth

| | Value |
|---|---|
| Collapsed | 720 × 56 |
| Input | single line, grows to **5 lines** then scrolls internally; composer height caps at 168 |
| Focused | border `hairline` → `accent` @ 40%; no size change |
| Below 1024 | width `calc(100% − 40px)`, mode chip drops to its glyph only |
| Below 768 | composer hidden; canvas is view-only (`UX_REDESIGN §13`) and a `meta` line says *"Running a team needs a wider window."* |

### 1.2 Keyboard

| Key | Action |
|---|---|
| `⌘↵` / `Ctrl↵` | **submit** — from anywhere in the app, including a focused canvas |
| `↵` | newline. Goals are prose and are often multi-line; Enter-to-submit would truncate thoughts mid-sentence |
| `Esc` | blur and collapse to one line, text preserved |
| `⌘⇧↵` | Save & run, when the document is dirty (§1.4) |
| `⌘K` → `Run team` | the palette route, so the flow is reachable without a pointer |

The button always renders its own shortcut, because `↵` not submitting is a surprise and the
label is where that surprise gets pre-empted.

### 1.3 Preflight — before a run is created

The composer validates **before** `POST /api/runs`, so the operator gets the reason next to
the button rather than after a round-trip. Each blocker replaces the button's right end with
a `meta` line and disables `Run`, reason on hover.

| Blocker | Line | Action |
|---|---|---|
| empty prompt | *"Type what the team should do."* | — |
| document `incomplete` / `invalid` | *"2 problems block this run."* | `[ Review ]` → the `§9.2` problems popover |
| **pipeline has ≠ 1 terminal agent** | *"A pipeline run needs exactly one final agent. This one has two: `author`, `qa`."* | `[ Show on canvas ]` selects both |
| team mode, no entrypoint | *"No entry point, so nothing would receive the goal."* | `[ Show on canvas ]` |
| no agents | *"Add an agent first."* | — |
| read-only / unsupported `schemaVersion` | *"This file is read-only."* | — |

The pipeline-terminal rule is `RUN_PROVENANCE_CONTRACT §4`: a valid pipeline for this
feature must have exactly one terminal configured agent, or start returns `422`. Catching it
client-side is a courtesy; the daemon remains the authority.

### 1.4 The dirty document — where the immutable revision becomes visible

A run executes **an exact snapshot of team-file bytes**, identified by
`sha256:<hex>` (ADR 0005 §1–2). The operator must never be able to think they ran what is on
screen when they ran what is on disk. So:

| Document state | Button | Second line |
|---|---|---|
| clean | `Run  ⌘↵` | — |
| **dirty** | `Save & run  ⌘⇧↵` (`accent-fill`) | *"Saves research-team.yaml first, then runs that exact revision."* |

There is **no "run without saving."** Offering it would mean either running stale bytes or
running unreviewed bytes, and both break the reviewability the snapshot exists to provide.
The operator's escape hatch is `Discard` in the document switcher, which is already there.

`Save & run` is one intent, two requests: conditional `PUT /api/team` (`If-Match` the loaded
revision), then `POST /api/runs` with `expectedRevision` = the revision the PUT returned.
The ledger sweep (`§9.1a`) plays on the chip for the save, and the composer holds
`Saving…` until the run is created — so the two steps stay legible as two steps.

### 1.5 Stale revision — the save/start race

If `PUT` returns `412` or `POST /api/runs` returns a revision conflict, the document changed
on disk since load. **No run is created.** The `§9.3` conflict bar takes over verbatim
(`Compare… / Keep mine / Use disk`), and the composer returns to its pre-submit state with
the prompt text **preserved**. Losing a typed goal to a file race would be unforgivable and
is the whole reason the text is held until the run id comes back.

### 1.6 Submit → idempotency

`⌘↵` generates one start key and holds it for the life of the attempt. Re-pressing `⌘↵`
while a start is in flight is a no-op, not a second run (ADR 0005 §8: start keys are unique
per principal and bind to a request fingerprint). The button shows `Starting…`, disabled.

A connection loss during submit **never** retries blind: the client re-`GET`s by start key.
Connection loss never starts, restarts or cancels a run.

### 1.7 What the composer deliberately does not have

No model picker, no temperature, no agent selector, no "run only this node", no attachments.
The team file is the configuration; the composer's only job is the goal. Anything else here
would be a second, invisible source of run configuration competing with the file — exactly
what the snapshot rule exists to prevent.

---

## 2. Run states

Straight from `RUN_PROVENANCE_CONTRACT §3.2`. Non-terminal: `queued`, `starting`,
`running`. Terminal: `succeeded`, `partial`, `failed`.

| State | Where it shows | Indicator | Copy |
|---|---|---|---|
| `queued` | Response node header | `accent` hollow ring | *"Queued — waiting for a supervisor."* |
| `starting` | " | `accent` rotating arc | *"Starting `researcher`…"* |
| `running` | " | `accent` filled dot, breathing | *"Running — 3 agents."* |
| `succeeded` | " | `ok` circle + check | *"Answered in 48s."* |
| `partial` | " | `alert` circle + `!` | *"Partial answer."* + the reason, §3.4 |
| `failed` | " | `alert` circle + × | the stable error code + verbatim message |

These reuse `DESIGN_LANGUAGE §12`'s status shapes exactly — same eight shapes, so an
operator who has learnt the agent-status vocabulary already reads run status.

### 2.1 `reconnecting` is not a run state

The contract is explicit: *"Reconnecting is a client transport state, not a run state,"* and
pause/cancel **must not be inferred from connection closure.** So reconnection never touches
the run indicator. It appears only as a transport strip, and the run keeps whatever state it
last reported.

This is the single easiest thing to get wrong in implementation, and it is the difference
between "your network blipped" and "your run died."

### 2.2 Two channels means two gap states

ADR 0005's consequence: the UI uses `RunEvent.seq` for exact evidence and the provenance
`cursor` for the redacted graph, and *"must independently recover gaps on each."* Therefore
two distinct, separately-worded indicators — never one merged "something's wrong":

| Channel | Strip | Copy | Placement |
|---|---|---|---|
| events (WS) | `halt`, `micro` | *"Live events reconnecting — answer shown to seq 1284."* | Response node footer |
| provenance (SSE) | `halt`, `micro` | *"Provenance reconnecting — graph shown to cursor 42."* | provenance summary header |

Both name the position they are complete to, because "reconnecting" without a watermark
tells the operator nothing about what they are looking at. On recovery each collapses to a
2 s `ok` chip and the missing range is backfilled by `?afterSeq=` / `?cursor=`.

---

## 3. The runtime overlay

### 3.1 Deterministic layout

`TNG-89F`: *"deterministic runtime layout"*, and *"never move or serialize saved
configuration nodes."*

The overlay is a **column to the right of the configuration graph's bounding box**, gutter
96 px, in canvas coordinates so it pans and zooms with the graph.

```
   configuration graph            96      runtime overlay column (420 wide)
 ┌─────────────────────────┐     │      ┌──────────────────────────────┐
 │  ① researcher           │     │      │ GOAL                         │
 │        ↘                │     │      │ Find out how ACP handles …    │
 │       ② reviewer        │     │      └──────────────────────────────┘
 │             ↘           │     │                    │ initiated
 │            ③ author ────┼─────┼──────▶┌──────────────────────────────┐
 │                         │     │      │ ● Running — 3 agents          │
 └─────────────────────────┘     │      │ RESPONSE                      │
   never moves, never resaved    │      │ ACP negotiates capabilities …  │
                                 │      └──────────────────────────────┘
                                 │                    │ contributed_to
                                 │      ┌──────┬──────┬──────┐
                                 │      │agents│tools │…     │  6 summaries
                                 │      └──────┴──────┴──────┘
```

Layout is a pure function of `(config bounding box, entity IDs)`. Entity IDs are
deterministic within a run (`CONTRACT §8.1`), so the same run always renders the same
picture — which is what makes a replayed run comparable to the live one.

On submit the canvas animates once to fit config + overlay (`move`, 240 ms). It does not
re-fit on every streamed token; a canvas that re-frames while you read is unusable.

### 3.2 Goal node

**420 × auto** (min 64, max 200 then internal scroll). `accent-tint` fill, 1 px `accent`,
`r-lg`. `micro` header `GOAL`. Body `body/14`. The submitted prompt verbatim.

On submit it **animates from the composer's input to its overlay position** (`move`, 240 ms,
`ease-out`); the composer's input clears. That one transition is what makes the goal feel
*placed on the canvas* rather than sent into a void. Reduced motion: it appears in place.

Never editable. Editing a submitted goal would imply the run changed; a new goal is a new
run. The node carries `[ Reuse ]`, which copies the text back into the composer.

### 3.3 Response node — the answer lives in the canvas

**420 × auto**, min 120, **max 560 then internal scroll**. `panel-solid` fill at 96%,
1 px `accent`, `r-lg`. This is the one runtime node that is opaque, because it is the thing
being read and `e2`'s law applies: never blur or tint text the operator is reading carefully.

```
┌──────────────────────────────────────────┐
│ ● Running — 3 agents          ⤢  ⋯       │  header: run status · focus · menu
│ RESPONSE · researcher                    │  micro — the canonical responder
│ ──────────────────────────────────────── │
│ ACP negotiates capabilities during the   │  markdown, allowlisted renderers
│ `initialize` handshake. The client…      │
│ ▌                                        │  caret while streaming
│ ──────────────────────────────────────── │
│ Live events reconnecting — to seq 1284   │  conditional, §2.2
└──────────────────────────────────────────┘
```

- **`RESPONSE · <agent>` names the canonical responder** — the entrypoint in team mode, the
  unique terminal node in pipeline mode (`CONTRACT §4`). Other agents' messages are
  evidence only and are **never** concatenated into the answer. Naming the responder on the
  node is how the operator can tell the answer from the chatter.
- **Streaming** appends text blocks in global `seq` order with no injected whitespace
  between adjacent chunks. A 2 px `accent` underline travels along the bottom edge while the
  canonical turn is open — the same visual family as the chip's ledger sweep, one meaning
  apart: *still being written*. Reduced motion: a static `accent` underline, no travel.
- **`⤢ Focus`** widens the node to 720, zooms the canvas to it at 1.0 and centres it. This
  is the answer to *"keep the full answer readable in the canvas"* — it grows in place
  instead of opening a side panel that would contradict the brief.
- **Allowlisted renderers only** (`CONTRACT §4`). Non-text ACP content blocks keep their
  order; anything without an allowlisted renderer shows a `meta` placeholder naming the
  block type. Never raw HTML.

### 3.4 `partial` and `failed`

`partial` is the state that matters most, because it is the one where the operator has
something and needs to know not to trust all of it.

```
┌──────────────────────────────────────────┐
│ ! Partial answer               ⤢  ⋯      │
│ RESPONSE · author                        │
│ ──────────────────────────────────────── │
│ …the assembled content, kept in full…    │
│ ──────────────────────────────────────── │
│ ⚠ `reviewer` crashed after 2 turns.      │  alert strip, verbatim + code
│   process_crashed · [ Show events ]      │
└──────────────────────────────────────────┘
```

- Content is **kept, never hidden** behind the error. `CONTRACT §4`: partial content remains
  available.
- The strip carries the **stable machine-readable error code** *and* the verbatim message —
  `UX_REDESIGN §16`'s rule, unchanged: LoomWatch never paraphrases a daemon error.
- `[ Show events ]` is the exact-evidence route and requires `runs:evidence` (ADR 0005 §7).
  Without that authorization the action is absent — not present-and-failing.
- `failed` has no content, so the node is the strip: code, verbatim message, `[ Reuse ]`.
  `missing_canonical_response` gets the plain-language second line *"The run finished but no
  agent produced an answer."*

---

## 4. Provenance

### 4.1 Six grouped summaries, then one hop at a time

`TNG-89F`: grouped summary nodes, **one-hop expansion**, filters, details inspector, Back to
response.

Beneath the Response, six **200 × 64** summary chips in fixed order — `agents`, `reasoning`,
`skills`, `tools`, `commands`, `sources` (`CONTRACT §12`'s categories, in its order). Fixed
order matters: the operator learns positions, and a graph that reorders itself by count is
unlearnable.

```
┌────────────────────┐   ┌────────────────────┐
│ ⛁ AGENTS         3 │   │ ⚑ SKILLS         — │
│ ● Complete         │   │ ○ Not captured     │
└────────────────────┘   └────────────────────┘
```

Each chip: category glyph, `micro` name, count (or `—`), and its **coverage level** as
shape + colour + word (§5.2). Click or `↵` expands **one hop**: that category's entities
appear as a row beneath it, connected by their real edge kind. Clicking an entity expands
*its* one hop. Nothing ever explodes the whole graph — at the approved graph-size limit
(`CONTRACT §10`) a full expansion is unreadable, and the one-hop rule is what keeps the
canvas usable instead of merely populated.

Collapse: click again, or `⌫` on a focused expanded node. **`[ Back to response ]`** collapses
everything and returns focus and viewport to the Response node.

### 4.2 Entity vocabulary

All eight `TraceEntity.kind` values (`CONTRACT §8.1`). Runtime material (§0): tinted, ringed,
never saved.

| Kind | Size | Glyph | Primary line | Secondary |
|---|---|---|---|---|
| `prompt` | 420 × auto | `MessageSquare` | the goal text | — (this is the Goal node, §3.2) |
| `response` | 420 × auto | `FileText` | the answer | canonical responder (§3.3) |
| `agent` | 200 × 64 | role glyph (`§12`) | agent name | `role · model` |
| `reasoning` | 240 × 64 | `Brain` | `thought` / `plan` | agent · turn |
| `skill` | 240 × 64 | `Puzzle` | skill identity | version or path fingerprint |
| `tool` | 240 × 64 | `Wrench` | `title` | `toolKind` · call status |
| `command` | 240 × 72 | `Terminal` | the command, `mono`, middle-truncated | exit status |
| `source` | 240 × 72 | `Link` / `FileCode` / `Globe` | normalized reference | source type |

**`agent` entities reuse the configuration node's role glyph but not its material** — same
identity, different layer. That is deliberate: the operator should recognise `reviewer` in
the trace as the same `reviewer` they configured, while never mistaking the trace chip for
the saved node.

**`reasoning` is `thought` and `plan` only.** `CONTRACT §8.1`: hidden chain-of-thought is
never requested or represented, and no inference from prose may label a skill, command or
source as used. The UI must therefore never render a "reasoning" node it synthesised from an
answer's prose — and this spec names that so nobody helpfully adds it.

### 4.3 Edge vocabulary — one treatment, ten labels

All ten `TraceEdge.kind` values: `initiated`, `participated`, `delegated_to`,
`reasoned_with`, `used_skill`, `invoked_tool`, `ran_command`, `consulted_source`,
`contributed_to`, `derived_from`.

**They share one stroke: 1 px solid `warp` at 60%, tiny open arrowhead, never animated.**
The kind appears as a `micro` `ink-3` label at the midpoint when the edge, or either
endpoint, is hovered, focused or selected.

The reasoning, because this is the one place I am deliberately not following the
edge-differentiation approach of `DESIGN_LANGUAGE §13`:

- The canvas already spends its edge vocabulary on a **named architecture requirement** —
  configured vs. observed must be distinguishable at a glance (`ARCHITECTURE §5`). Ten more
  stroke treatments would drown the two that carry that requirement.
- Provenance edges explain a **finished** thing. Animation means *happening now* in this
  language; animating provenance would make a completed trace compete with a live run for
  the same meaning.
- Ten dash patterns are not distinguishable at canvas zoom anyway — the same finding that
  collapsed v1's three violets into dash-and-marker separation.

So: the weft stays the loudest thing on the canvas, and provenance is a quiet lattice you
read by hovering. If the board wants edge kinds always-on, the honest version is a legend
toggle (`L` already cycles layer solo), not ten strokes.

### 4.4 Filters and the details inspector

**Filters** — a 200 px `e1` block above the summaries, present only while a trace is
expanded: one toggle per category plus `Only redacted` and `Only not captured`. Filtering is
**view state, never document state** (the `§6.7` rule, unchanged) and never re-runs the
projector.

**Details inspector** — reuses the `§5.4` inspector shell on the right, so there is one
detail surface in the product, not two. It shows the entity's kind, identity, capture value
with its reason, evidence event IDs (when the principal holds `runs:evidence`), adapter id
and version for observations, and the redaction paths that were applied. Selecting a
provenance entity replaces the agent inspector's content; `Esc` returns to the response.

---

## 5. Evidence quality — the honesty layer

### 5.1 Four capture states, visible *and* textual

`TNG-89F` requires recorded, derived, redacted and unavailable to be *"visibly and textually
distinct."* `DESIGN_LANGUAGE §8` Law 3 already forbids colour as the only channel. So each
state gets a border treatment, a glyph **and** a word — three channels, and the word is
never omitted to save space.

| `capture` | Border | Fill | Glyph | Word | Means |
|---|---|---|---|---|---|
| `recorded` | 1 px solid `accent` | `accent-tint` | filled dot | **Recorded** | explicit protocol or adapter evidence |
| `derived` | 1 px **dashed** `warp` | none | hollow ring | **Derived** | deterministic relationship from recorded evidence |
| `redacted` | 1 px solid `halt` | 4 px diagonal hatch, `halt` @ 8% | lock | **Redacted** | evidence exists; public fields removed by policy |
| `unavailable` | 1 px **dotted** `ink-3` @ 40% | none | dashed ring | **Not captured** | not emitted, unsupported, malformed, or dropped by a limit |

Greyscale proof, the `§16` acceptance test: drop all colour and the four remain
`solid+dot` / `dashed+ring` / `solid+hatch+lock` / `dotted+dashed-ring`. Four distinct rows,
no colour used.

**`unavailable` always states its reason**, from the contract's stable reason codes — *"No
skill adapter installed"*, *"Tool inputs were opaque"*, *"Dropped by trace limit"*. An empty
category with no explanation reads as a bug in LoomWatch; the same category with a reason
reads as an honest boundary. That difference is most of the trust this feature is for.

**`redacted` never shows a keyhole.** No hover-to-reveal, no "request access" affordance on
the node. Default provenance surfaces are redacted before delivery and fail closed (ADR 0005
§7); an affordance implying the bytes are one click away would be a lie about the privacy
contract.

### 5.2 Coverage, and the word "complete"

Each category publishes `level: complete | partial | unavailable` (`CONTRACT §12`).

| Level | Chip indicator | Word |
|---|---|---|
| `complete` | `ok` filled dot | **Complete** |
| `partial` | `accent` half dot | **Partial** |
| `unavailable` | `ink-3` dashed ring | **Not captured** |

A graph-level **"Complete capture"** label is permitted **only** when every requested
category is `complete`. Otherwise the header reads **"Partial capture"** and names the gaps:
*"Partial capture — skills and commands not captured."* This is a contract requirement, and
it is the sentence that keeps the whole provenance view honest: the graph shows what was
observed, and says plainly where it could not see.

`complete` is also scoped in words the operator can check: the header's tooltip reads
*"Complete for what the adapters can observe — never an agent's private internal state."*

---

## 6. Focus order and the accessible outline

### 6.1 Tab order

1. Composer: input → primary action → run history (the mode display is informational)
2. Document chip → library → inspector (existing, `UX_REDESIGN §11`)
3. Canvas configuration nodes, in `pipeline_order()` else creation order
4. **Runtime overlay:** live-activity cards in event order → Response → filters → the six
   summaries in fixed order → expanded entities in deterministic entity-ID order

Expansion never steals focus. Collapsing a subtree returns focus to the node that owned it;
`[ Back to response ]` returns focus to the Response node. Focus is stable across
expand/collapse — a requirement of `TNG-89F`, and the reason order is by deterministic ID
rather than by arrival.

TNG-115 makes the activation contract explicit. Configuration nodes and live-activity
cards are native buttons. The terminal Response keeps `role="button"` because its structured
answer cannot validly be nested in a native button; `Enter` and `Space` run the click path,
and Space prevents viewport scrolling. `aria-expanded` tracks every inspector/provenance
disclosure. `Esc` unwinds activity panel → entity → category → provenance and returns focus
to the control that owned the dismissed layer.

### 6.2 The synchronized outline

`TNG-89F` requires a synchronized accessible outline. A `role="tree"` panel mirrors the
overlay one-for-one — same nodes, same order, same expand/collapse state, driven by the same
state. It is not a second implementation of the graph; it is the graph's model rendered as a
list, which is the only way the two cannot drift.

Opened with `⌘⌥O` or from ⌘K (`Show provenance outline`). Each row announces
`"<kind>, <name>, <capture word>, <n> children"`.

### 6.3 Live regions

Polite: run state changes, streaming start and end, category counts, expansion and
collapse, filter changes, reconnect and recovery on **both** channels.
Assertive: `failed`, `partial`, preflight blockers, and the stale-revision conflict.

Streaming text is **not** announced token by token — that would make a screen reader
unusable. The response's `aria-live` region updates once on turn end with the complete
answer; while streaming, the status line announces *"Response streaming"* once.

### 6.4 Accessible names

- Goal — `"Goal: <text>"`
- Response — `"Response from <agent>, <run state>"`
- Summary chip — `"<category>, <n> entities, <coverage word>"`
- Entity — `"<kind>: <name>, <capture word>"` + the reason when `unavailable`
- Provenance edge — `"<edge kind> from <a> to <b>"`

---

## 7. State transitions

```
COMPOSER
  empty ──type──► ready ──⌘↵──► starting ──runId──► (overlay opens)
    ▲               │                          │
    │               ├─blocker──► blocked ──fix─┘
    │               └─dirty────► save&run ─412─► conflict ─┐
    └──────────────── text preserved ────────────────────── ┘

RUN            (RUN_PROVENANCE_CONTRACT §3.2 — monotonic, terminal never re-transitions)
  queued ─► starting ─► running ─┬─normal────────────► succeeded
     │          │                ├─abnormal + output─► partial
     │          └─startup fail──►├─abnormal, no output► failed
     └─supervisor/archive fail──►┘

TRANSPORT      (independent of run state, both channels, §2.2)
  live ⇄ reconnecting ─► recovered(backfill) ─► live

PROVENANCE
  none ─► summaries ─(one hop)─► expanded ─(one hop)─► expanded′
              ▲                      │                     │
              └──── Back to response ─┴─────────────────────┘
```

---

## 8. What this spec does not decide

Escalated or owned elsewhere; **not** decided here:

1. **Cancellation.** `CONTRACT §3.2` places pause, resume, mid-run steering and cancellation
   outside the contract, and `ARCHITECTURE §6` defers writes to running execution. TNG-119
   requires the prototype to preserve a clickable cancelled/retry path, so Stop is a
   design-state demonstration only. Production still requires an `ARCHITECTURE §6`
   amendment plus an authenticated cancel command and terminal event.
2. **`runs:evidence` authorization UX.** `[ Show events ]` is absent without the scope
   rather than present-and-failing. How a principal *obtains* the scope is not a canvas
   concern.
3. **Approved graph-size limit** (`CONTRACT §10`) — the number is the contract's. The design
   only commits to remaining usable at it via one-hop expansion and filters.
4. **Which capture adapters exist at launch.** The design renders `unavailable` with a
   reason honestly for every category, so it is correct whether zero or six adapters ship.
   The demo's `release-evidence` skill node assumes an explicit accepted `used_skill` event;
   without such an adapter/event, the category reads **Not captured** rather than inferring use.
5. **Notification content for run completion** — phase 05, `CANVAS_SPEC §14`.

---

## 9. Deltas to previously approved specs

Building this forced changes to documents already published. These are the reconcilable
list; nothing here contradicts ADR 0005.

| # | Change | Was | Why |
|---|---|---|---|
| 1 | The mode pill becomes the composer's mode chip | own `e1` pill, bottom-centre (`CANVAS_SPEC §8.1`) | the pill explains how the run will execute; that belongs at the run action. Spends the 36 px slot `§14` reserved. |
| 2 | The run slot is **start-only**, and now enabled | reserved + disabled, *"Running a team arrives in a later phase"* (`§14`) | TNG-89 authorizes running. No stop, per §8.1. |
| 3 | A runtime overlay layer joins the z-order | four layers (`UX_REDESIGN §3`) | runtime nodes must never be confused with, or move, configuration nodes |
| 4 | Bottom chrome positions from `--lw-bottom-offset` | `§14` said "a variable, not a constant" | now there are three bottom occupants (composer, view controls, future scrubber) |
| 5 | Provenance edges get **one** stroke, not ten | — | `§4.3`: protecting the warp/weft distinction that `ARCHITECTURE §5` names |
| 6 | The inspector is shared with provenance entities | agent-only (`§5.4`) | one detail surface, not two |

---

## 10. Acceptance — how a reviewer fails this

1. A run mutates YAML, or moves a saved node position. **Fail.**
2. A runtime node is indistinguishable in material from a configuration node. **Fail.**
3. Reconnection changes the run state indicator, or one merged indicator covers both
   channels. **Fail.**
4. A `Stop`, `Pause` or mid-run steering control exists. **Fail** (`ARCHITECTURE §6`).
5. An `unavailable` category renders without its reason. **Fail.**
6. `redacted` offers any reveal or request-access affordance. **Fail.**
7. "Complete capture" appears while any requested category is not `complete`. **Fail.**
8. Any of the four capture states is distinguishable by colour alone. **Fail** (greyscale
   test, §5.1).
9. Expanding a category expands more than one hop, or reorders the summaries by count.
   **Fail.**
10. A skill, command or source node exists that was inferred from prose. **Fail**
    (`CONTRACT §8.1`).
11. Streaming text is announced token-by-token to a screen reader. **Fail.**
12. A typed goal is lost to a revision conflict. **Fail.**

---

## 11. TNG-113 board revision — live agent/task provenance

This section supersedes §0/§2/§4 where the earlier candidate treated live activity as a
generic run overlay. The canvas now answers three separate questions without opening an
inspector: **what is each agent doing, what evidence did it produce, and which lifecycle is
the displayed state describing?**

### 11.1 Agent task treatment

Every participating configuration node gains a runtime-only task row. It never serializes
to YAML and does not change the saved node position.

| Agent task state | Perimeter | Glyph + visible text | Motion |
|---|---|---|---|
| `queued` | hairline | hollow ring + `QUEUED` + task title | none |
| `starting` | blue `live` | rotating arc + `STARTING` + task title | rotating arc and breathing border |
| `running` / `streaming` | blue `live` | filled dot + `RUNNING` / `STREAMING` + task title | breathing border |
| `done` | semantic `ok` | check + `DONE` + completed task title | none |
| `error` | semantic `alert` | × + `ERROR` + failed task title | none |
| `cancelled` | dashed `halt` | square + `CANCELLED` + preserved task title | none |
| `offline` | dotted neutral | dashed ring + `OFFLINE` + last known task | none |

Reduced motion replaces the breathing perimeter with a static 2 px blue border and blue
tint ring. The glyph, state word, and task title do not change, so motion and colour are
never required to understand state.

### 11.2 Three lifecycles, never collapsed

The live response header shows a compact three-column summary:

| Surface | Vocabulary | Important distinction |
|---|---|---|
| **Agent task** | `queued → starting → running/streaming → done/error/cancelled/offline` | Agent A may be `done` while Agent B and the run are still `running`. |
| **Run** | `queued → starting → running → succeeded/partial/failed/cancelled` | `succeeded` is the run terminal, not the response label. |
| **Result** | `not started → streaming → done/partial/error` | `done` describes the durable response content. |
| **View** | `live` / `replay` | Replay is inert and never re-executes or appears live. |

### 11.3 Automatic evidence materialization and ownership

An accepted observable activity event immediately projects one evidence node and one edge
from the agent that performed it. The prototype demonstrates the required first event:

```text
#01 · 02.1s · Agent A · invoked_tool · Notion · RUNNING → SUCCEEDED
Agent A ───────────────────────────────────────────────► Notion
```

The same renderer then projects `knowledge search`, `repository`, `external source`,
recorded `skill`, `file`, and sanitized `command` activity. Cards share geometry, but always show kind,
ordinal, event time, status, and owner. A multi-agent handoff changes the origin of later
edges: Agent A owns Notion/search/repository/source; Agent B owns file/command. Reordering
the viewport never changes event order.

Post-run expansion preserves those direct agent → evidence edges. The details view exposes:

- concise rationale summaries and explicit handoff summaries, never hidden chain-of-thought;
- citation label/location for sources;
- sanitized command text, exit status, duration, and expandable bounded output;
- capture status (`recorded`, `derived`, `redacted`, `unavailable`) and any stable reason.

### 11.4 Event/schema/backend annotations — design assumptions only

These annotations do **not** amend `RunEvent`, implement an endpoint, or authorize backend
work. The projector needs an observable activity envelope equivalent to:

```json
{
  "runId": "run_…",
  "eventId": "evt_…",
  "seq": 17,
  "occurredAt": "2026-09-09T15:02:01.100Z",
  "agentId": "researcher",
  "task": { "id": "task_…", "label": "Query Notion workspace", "state": "running" },
  "activity": {
    "kind": "tool",
    "label": "Notion",
    "status": "running",
    "sanitized": true,
    "capture": "recorded"
  }
}
```

Assumptions:

1. `agentId`, monotonic `seq`, and stable `eventId` are present before projection; the UI
   never infers ownership from names, prompt text, or arrival adjacency.
2. Tool start/completion pairs share a stable activity ID, so Notion is revealed once and
   updates state rather than duplicating.
3. Search, file, repository, and external locations arrive as source subtypes within the
   existing provenance entity vocabulary unless a future contract explicitly adds kinds.
4. Skill use arrives only as an accepted observable activity event with a stable skill ID;
   prompt text, installation, or filesystem presence alone never becomes a skill node.
5. Command text and output are sanitized before delivery; the UI does not become a secret
   scrubber. Output is bounded/paged and remains collapsed by default.
6. Replay consumes the persisted projected graph and ordered timestamps; it never calls the
   tool, command, source, or agent again.
7. Transport `offline` is independent of task/run state. The last known task remains visible
   with an `OFFLINE` qualifier and watermark until recovery/backfill.

### 11.5 Additional acceptance failures

13. A running agent lacks a blue perimeter or visible task/state text. **Fail.**
14. Reduced motion removes the live-state distinction. **Fail.**
15. Triggering Notion does not create/reveal one Agent A → Notion edge. **Fail.**
16. Search, repository/file, command, or external source activity uses a different ownership
    rule or lacks order/time/status. **Fail.**
17. A finished Agent A task forces the whole run/result to read `done`. **Fail.**
18. Replay animates, calls anything, or loses direct agent ownership. **Fail.**

### 11.6 TNG-115 keyboard and narrow composition

Below 768 px the prototype stops fitting the entire 1600 × 1000 stage with a transform.
The run workspace becomes one source-ordered Command / Inspect column:

```text
document + theme
Prompt → Run branch → lead Agent A → Agent A evidence
→ delegated Agent B → Agent B evidence → Output / response
coverage → filters → summaries → selected evidence
viewport-docked composer
```

Configured/provenance edge geometry and the library are omitted at this width. Their
essential information is not: cards continue to state owner, event order/time, status,
capture quality, and relationship. The composition keeps authored text sizes and 44 px
targets, uses an overlay sheet for either inspector, and keeps prompt/run/history/theme
controls reachable. Quarry Light and Obsidian & Gilt reflow identically because the narrow
rules consume only semantic tokens.

Additional acceptance failures:

19. Enter or Space on a node, activity card, or terminal Response differs from click, or
    Space scrolls instead of activating. **Fail.**
20. Closing an inspector, activity panel, entity/category disclosure, provenance view, or
    popover loses focus or returns it to an unrelated control. **Fail.**
21. A viewport below 768 px uses whole-stage scaling, clips the composer/response, makes a
    core action smaller than 44 px, or hides theme switching. **Fail.**
22. Narrow mode loses submission, response/provenance selection, filtering, automatic
    Agent A → Notion evidence, or cancel/retry state coverage. **Fail.**

---

## 12. TNG-119 revision — prompt-to-output is the primary graph narrative

This section supersedes any earlier composition that positioned Goal and Response as a
sidecar to the configured team. It revises the design prototype and documentation only; it
does not implement or authorize a production component, endpoint, event, or schema change.

### 12.1 Information hierarchy

The canvas first reads as one causal sentence:

```text
Prompt / user request ─starts─► Run 01 ─assigns lead─► Agent A
Agent A ─delegates review─► Agent B ─responds with─► Output / response
Run 01 ─completes as───────────────────────────────► Output / response

Agent A ─invoked tool─► Notion
Agent A ─searched / read / consulted / used─► its evidence
Agent B ─read / ran──────────────────────────► its evidence
```

The durable Prompt is first and the terminal Output is last. Lifecycle summary and chrome
support that story. Provenance summaries, details, and filters are tertiary: opening or
filtering them never removes or reorders the causal spine.

### 12.2 Node vocabulary

| Visible node | Meaning | Required visible content |
|---|---|---|
| **Prompt · user request** | exact submitted input | verbatim text and `Original kept`; survives all terminal states and retry |
| **Run NN** | one immutable attempt | attempt number, state, live/replay, retry parent when present |
| **Agent A · lead** | initiating task owner | owner, task title, queued/starting/running/streaming/done/error/cancelled/offline word |
| **Agent B · responder** | delegated owner and canonical responder | same task contract plus incoming delegation |
| **Evidence** | observed tool, command, knowledge search, file, repository, source, or skill activity | exact owner, relation, order, time, status, and capture quality in detail |
| **Output / response** | streaming or terminal result | producing agent, result state, retained partial/error/cancel content, provenance disclosure |
| **Previous branch** | retained retry ancestor | prior run/state and accumulated evidence list; never merges with the next attempt |

`Goal` remains contract terminology; this surface visibly types the node **Prompt · user
request** to make origin and durability legible without contract knowledge.

### 12.3 Edge meanings and direction

Every arrow points from cause/owner to effect. Visible names are `starts`, `assigns lead`,
`delegates review`, `invoked tool`, `searched knowledge`, `read repository`, `consulted
source`, `used skill`, `read file`, `ran command`, `responds with`, `completes as`, and
`retry preserves`. Prompt never points directly to Output. Every evidence edge starts at
the exact producing agent. Completed/replayed provenance is neutral; only work happening
now may use the animated blue live stroke.

### 12.4 Ordering, retention, live, and replay

1. Place Prompt, attempt, lead, delegated agents, and Output in causal order.
2. Under each agent, sort evidence by accepted event `seq`; layout may wrap, but ordinal and
   time never change.
3. The demo first projects **Agent A → Notion · invoked tool**, then knowledge search,
   repository, external source, explicit skill, Agent B file, and Agent B command evidence.
4. Terminal, partial, failed, and cancelled states freeze the Prompt, spine, accepted
   evidence, and available response content.
5. Retry snapshots the prior run plus accumulated evidence and creates the distinguishable
   next `Run NN`. Branches never merge.
6. Replay renders the same retained IDs, order, timestamps, branch lineage, and ownership
   without animation, calls, or re-execution.
7. Filtering affects detail/summary results only, never Prompt, run, agents, owner edges, or
   Output.

Live mode steps through queued → starting → running/streaming → terminal. Motion is limited
to the current blue agent perimeter, live evidence edge, and streaming underline. Reduced
motion replaces these with a static 2 px blue perimeter and static dashed live edge.
Reconnection remains transport state and cannot create, cancel, or advance a run.

### 12.5 Accessibility and theme tokens

Agent and evidence cards are native buttons. Enter and Space match click; Space never
scrolls. Output is a focusable article with button semantics only when it expands
provenance. `aria-expanded` mirrors Response, category, entity, and previous-branch state.
Esc unwinds the deepest disclosure and restores focus to its trigger. At 390 px, CSS/DOM
order follows the same causal sentence, every primary target is at least 44 px, and edge
geometry disappears only where relationship words remain on cards.

Both Quarry Light and Obsidian & Gilt consume the existing semantic/component tokens. Blue
is live only; `ok`, `alert`, and `halt` carry success, error, cancellation/offline with
glyphs and words. Gold/bronze remains scarce emphasis/focus and does not decorate every
terminal or edge. No new product hex values are introduced.

### 12.6 Backend/schema and rationale assumptions

- `Run NN`, `Agent A/B`, and relationship text are presentation labels over stable Prompt,
  Run, agent, response, and provenance IDs.
- Ownership requires `runId`, `agentId`, task/event IDs, monotonic `seq`, timestamp,
  activity kind/status, sanitized label/subtype, and capture status before projection. The
  client never infers ownership from names, prompt prose, or arrival adjacency.
- Search, file, repository, and external location remain source subtypes unless the contract
  adds kinds. A skill node requires an accepted observable `used_skill` event; installation,
  filesystem presence, or prose mention alone is not use.
- Output producer identity must be delivered or mapped from the canonical final agent; it
  may not be inferred from answer prose.
- Retry requires a new run ID plus `retryOfRunId` (or equivalent lineage) and retained prior
  projection. Sequential numbers are display labels, not identifiers.
- Cancel is demonstrated because TNG-119 requires cancelled/retry paths, but the current
  contract does not authorize it. Production needs an authenticated cancel command and
  terminal event; closing a connection is not cancellation.
- None of this changes `team.schema.yaml`, writes runtime nodes to YAML, or amends the frozen
  WebSocket schema.

The UI may expose concise recorded/derived rationale summaries, citations, sanitized tool
or command evidence, and capture gaps. It never requests, stores, labels, or reveals hidden
chain-of-thought, and never materializes evidence from prose alone.

Additional acceptance failures:

23. The first durable runtime node is not visibly Prompt, Goal, or User request. **Fail.**
24. Named direction cannot be followed Prompt → run → lead → delegation → evidence → responder → Output. **Fail.**
25. Expansion or filtering removes the causal spine. **Fail.**
26. Terminal/cancel/error/retry loses original input or accepted evidence. **Fail.**
27. Retry overwrites the prior branch. **Fail.**
28. Any required evidence type lacks exact producer ownership, order, time, or state. **Fail.**

---

## 13. TNG-121 revision — the live pipeline is editable; bounded node and history UI

This section revises the design prototype and documentation only. It does not implement or
authorize a production component, endpoint, event, or schema change.

### 13.1 The Available-team panel

A 340 px `e1` panel, top right, lists five placeable agents: three detected harnesses
(`opencode`, `claude`, `codex`) and the two role presets (`Reviewer`, `Researcher`). It
appears on every live workspace screen, is hidden while the inspector or activity panel
owns the right edge, and is absent below 768 px (placement is a desktop composition
interaction; the narrow column stays read-only). A row is a drag source **and** a keyboard
source; clicking it does nothing.

### 13.2 Drop slots and the pointer path

While a palette row is mid-drag, dashed **drop slots render between every consecutive pair
of pipeline steps** — never before the lead or after the responder, because the prototype
pins those two anchors. Hovering a slot switches it to a solid accent border plus tint
(the unambiguous valid-drop state); releasing inserts the agent at that index.

### 13.3 The keyboard path

`Enter` on a palette row **arms** placement: the row gains an accent treatment, the slots
appear, and focus moves to the first slot. `Tab` cycles slots, `Enter` inserts at the
focused slot, `Esc` cancels and restores focus to the row. `Enter` on a slot without an
armed source is a no-op. A `role="status"` live region announces armed / inserted /
cancelled / removed, so the pointer-only action has a first-class keyboard-and-screen-reader
equivalent.

### 13.4 The graph is the feedback

Insertion is visible in the story itself, not only in prose: the inserted step takes the
next step number, both adjacent `delegates review` edges re-anchor to it (the prompt
therefore flows *through* it), evidence cards re-anchor under their owning agent's new
position, the composer chip recomputes `Pipeline · N steps`, and the slot labels and
pipeline step badges renumber. Focus moves to the inserted node; its inspector Delete
button (enabled only for steps inserted this session) removes it and restores focus to the
nearest surviving step. The demo bounds the pipeline at three steps; further placement is
refused with an announcement and the palette reports `Pipeline full`.

### 13.5 Overflow repair

- Durable Prompt: grows to a 132 px body, then scrolls internally; text wraps anywhere.
- Response header: the phase line ellipsizes before the Live/Replay badge can be pushed out.
- Evidence cards: every line truncates (ellipsis) inside the 180 px card; no collisions.
- Lifecycle strip wraps; prior-branch card scrolls internally at 284 px.
- Run history: rows clip long goals; the list scrolls inside the popover.
- Expanded provenance renders in a **bounded tray** anchored above the stage floor
  (`top ≥ 700`, height to the stage edge), scrolling internally — it can no longer paint
  past the stage or under the composer. `Back to response` lives in the tray header.
- Narrow (≤ 767 px): the tray joins the reading column at full width; nothing scales.

### 13.6 Backend/schema assumptions — design only, not implemented

- Editing the live pipeline implies a **run-time team revision** operation: the client
  needs an authorized `updateTeamConfiguration`-class command that produces a new immutable
  revision of the executed team (same lineage rules as `retryOfRunId`, i.e. a
  `revisionOf`/`supersedes` reference) — the current contract has no such command.
- Inserted agents need to be **spawnable mid-run**: ownership projection requires the same
  `runId`/`agentId`/`seq` fields for a step added after run start; nothing in
  `RUN_PROVENANCE_CONTRACT` today assigns a task to an agent that joined mid-run.
- Evidence produced by an inserted step must arrive as ordinary accepted events; the UI
  never fabricates evidence for a step that has not yet emitted any (an inserted step
  renders `idle/QUEUED` until its first accepted event).
- The bounded three-step limit is a **prototype legibility bound**, not a contract limit.
- None of this changes `team.schema.yaml`, writes runtime nodes to YAML, or amends the
  frozen WebSocket schema.

Additional acceptance failures:

29. A palette row can be dragged but no between-step drop target appears, or the valid-drop
    state is ambiguous. **Fail.**
30. Insertion updates explanatory copy but the graph (edges, step numbers, evidence
    anchoring, `Pipeline · N steps`) does not change. **Fail.**
31. The drag action has no keyboard equivalent, or arming/cancelling loses focus. **Fail.**
32. Any node, response, evidence, prior-branch, or history content paints outside its card
    or the stage, or collides with other chrome, at 1600 × 1000 or 390 px, in either
    theme. **Fail.**
33. Placement silently succeeds past the stated bound, or mutates a replayed/finished
    branch. **Fail.**

---

## 14. TNG-122 / TNG-123 revision — freeform placement, typed wiring, and the capability library

This section revises the design prototype and documentation only. It does not implement or
authorize a production component, endpoint, event, or schema change. It runs alongside §12/§13:
the run screens keep their slot pipeline; the freeform canvas is the separate free-arrangement
surface the board asked for (screen 5, deep link `#wiring,<theme>`).

The fuller product recommendation, including permission boundaries and persistence options,
is in [`TNG122_FREEFORM_CAPABILITY_COMPOSER.md`](TNG122_FREEFORM_CAPABILITY_COMPOSER.md).

### 14.1 The capability library

The left library becomes the capability library: **Agents, Skills, Tools & connectors, Knowledge
sources** — every resource available and authorized in the current workspace, in four collapsible
groups with per-group `shown/total` counts. Each row carries a state badge, a wired-count badge
(live, on the wiring screen), and a compatibility cue in words. Controls: a search field, a
category filter row, and a state filter (`Any state / Available / Needs approval /
Disconnected`), plus a footer that states `N of M resources match · K usable here` and — when the
workspace hides resources by policy — `n hidden by workspace policy`. A globally hidden resource
is never rendered as a row; the footer counts it, so the boundary is stated without advertising
what cannot be used. A search that matches nothing renders the honest empty state in every group.

Rows that are **not usable** (not installed, disconnected) remain visible with their reason,
render greyed, and cannot be dragged or keyboard-placed. Rows that need run-time approval
(`Needs approval`) are usable: placing and wiring them works, and the resulting edge carries a
`needs approval` badge.

### 14.2 Free placement

Pointer: dragging a usable row shows a drop ghost that follows the pointer over the canvas;
releasing places the node exactly there (clamped to the stage). Nodes drag anywhere; edges
re-anchor while the pointer moves. Keyboard: `Enter` on a row arms a placement ghost,
`←→↑↓` move it (`Shift` = 32 px steps), `Enter` drops, `Esc` cancels and restores focus to the
row. Arrow keys nudge a selected node by the same steps. A live region (the TNG-121 channel)
narrates arm / move / drop / cancel, and the wire strip states the armed placement.

### 14.3 Typed wiring

The only valid connections are the board-named relationships:

```text
prompt/goal → agent (assigns goal)      agent → agent (hands off to)
agent → skill (uses)                    agent → tool/connector (invokes)
agent → knowledge source (consults)     agent / evidence → response/output (responds with)
```

Pointer: drag a node's right handle onto a target — candidate targets light up valid (accent
ring) or refused (dashed alert ring) while the temp edge follows the pointer. Keyboard: select a
node, press `W` — `Tab` cycles every other node as a candidate, each announced with its validity
or its refusal reason, `Enter` commits, `Esc` cancels. Selected edges expose two endpoint dots
(drag to re-aim either end), `R` arms a rewire of the target, and `Delete` removes.

### 14.4 Non-destructive refusals

A connection without a rule — resource → agent, response → anything, prompt → non-agent, a
duplicate, or a self-loop — is refused: an explanation appears in the wire strip, the strip
shakes once (static under reduced motion), the live region reads the refusal, and **nothing is
created or changed**. Skills, tools and knowledge sources state the general rule in their own
refusal: they are used by agents and never originate a connection.

### 14.5 Planned vs observed — two layers, never merged

Grey solid edges with named relation labels are the **planned graph**: user-authored, editable,
document state. Blue dashed edges, gold shuttle travel on the planned handoff edge, and the
evidence cards are **observed provenance**: projected automatically from live run events on a
timer, never authored, never written to the file. The selected planned edge turns accent with
its relation word highlighted; observed evidence keeps the recorded ordinal, owner, relation,
and time. The wire strip shows `Planned n · Observed ×k` so the two counts are readable without
the legend (the bottom-left legend would sit under the library on this screen, so the strip
carries the counts instead — same layer rule, different chrome position).

### 14.6 Status, replay, themes

The run-state system is unchanged: the blue breathing border appears only while the lead agent
is actively executing, and the reduced-motion equivalent is the static 2 px blue perimeter;
completion freezes the path to `succeeded`. `Replay observed run` re-renders all three evidence
events inertly and labelled **Replay** — no shuttle, no live edges, no re-execution — while the
planned graph stays untouched and editable. Both themes, the 390 px composition (read-only
column: nodes, evidence, no strip/legend/viewctl), overflow bounds, and the greyscale rules of
§16 apply unchanged.

### 14.7 Backend/schema assumptions — design only, not implemented

- Free placement and typed wiring imply a **graph document model** for team files (nodes with
  free coordinates, typed edges) that `team.schema.yaml` does not have today; the current
  pipeline/team modes remain the only executable shapes.
- Edge typing and per-edge permission badges assume the run planner can consume declared
  `uses/invokes/consults` relations and gate approval-requiring resources at run time; no such
  planner contract exists yet.
- The library assumes a workspace capability catalogue endpoint (agents, skills, connectors,
  knowledge sources with status and authorization) — `GET /api/harnesses` covers agents only.
- Hidden-by-policy resources assume a policy filter in that catalogue; the footer count is a
  design placeholder for it.
- None of this amends `RUN_PROVENANCE_CONTRACT`, the frozen WebSocket schema, or any shipped
  endpoint; the prototype fabricates nothing that the run screens did not already show.

Additional acceptance failures:

34. A library row for a resource that is not available or not authorized renders as if usable,
    or a hidden resource is listed. **Fail.**
35. Free placement snaps to fixed slots, or a dropped node lands anywhere other than the drop
    point (pointer) or the ghost position (keyboard). **Fail.**
36. An invalid connection is drawn anyway, silently dropped without an explanation, or its
    refusal changes existing nodes or edges. **Fail.**
37. Wiring, rewiring, or removal has no keyboard equivalent, or candidate cycling does not
    announce each candidate's validity. **Fail.**
38. Observed provenance renders as planned wiring (or vice versa), replay re-executes or moves,
    or the observed projection does not arrive automatically from run events. **Fail.**
