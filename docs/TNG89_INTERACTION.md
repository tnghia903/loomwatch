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

1. Composer: mode chip → input → primary action
2. Document chip → library → inspector (existing, `UX_REDESIGN §11`)
3. Canvas configuration nodes, in `pipeline_order()` else creation order
4. **Runtime overlay:** Goal → Response → filters → the six summaries in fixed order →
   expanded entities in deterministic entity-ID order

Expansion never steals focus. Collapsing a subtree returns focus to the node that owned it;
`[ Back to response ]` returns focus to the Response node. Focus is stable across
expand/collapse — a requirement of `TNG-89F`, and the reason order is by deterministic ID
rather than by arrival.

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
   outside the contract, and `ARCHITECTURE §6` defers writes to running execution. So there
   is **no Stop control** in this design, and the composer's action is start-only. If the
   board wants a stop, it is an `ARCHITECTURE §6` amendment plus a contract change — not a
   button.
2. **`runs:evidence` authorization UX.** `[ Show events ]` is absent without the scope
   rather than present-and-failing. How a principal *obtains* the scope is not a canvas
   concern.
3. **Approved graph-size limit** (`CONTRACT §10`) — the number is the contract's. The design
   only commits to remaining usable at it via one-hop expansion and filters.
4. **Which capture adapters exist at launch.** The design renders `unavailable` with a
   reason honestly for every category, so it is correct whether zero or six adapters ship.
   `skills` in particular has no adapter today and will read **Not captured** — by design,
   not as a defect.
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
`file`, and sanitized `command` activity. Cards share geometry, but always show kind,
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
4. Command text and output are sanitized before delivery; the UI does not become a secret
   scrubber. Output is bounded/paged and remains collapsed by default.
5. Replay consumes the persisted projected graph and ordered timestamps; it never calls the
   tool, command, source, or agent again.
6. Transport `offline` is independent of task/run state. The last known task remains visible
   with an `OFFLINE` qualifier and watermark until recovery/backfill.

### 11.5 Additional acceptance failures

13. A running agent lacks a blue perimeter or visible task/state text. **Fail.**
14. Reduced motion removes the live-state distinction. **Fail.**
15. Triggering Notion does not create/reveal one Agent A → Notion edge. **Fail.**
16. Search, repository/file, command, or external source activity uses a different ownership
    rule or lacks order/time/status. **Fail.**
17. A finished Agent A task forces the whole run/result to read `done`. **Fail.**
18. Replay animates, calls anything, or loses direct agent ownership. **Fail.**
