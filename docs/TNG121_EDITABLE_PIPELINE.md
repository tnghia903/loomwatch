# LoomWatch — TNG-121 design spec: editable live pipeline + overflow containment

**Status:** design specification only. Written by Product/UX Designer for the
implementer of [TNG-121]. It revises the design prototype and design docs only. It does
not implement or authorize a production component, endpoint, event, or schema change.

**How to use this file:** sections 1–4 are drafted as **§13 of `docs/TNG89_INTERACTION.md`**.
When you update that file per TNG-121 item 5, fold these sections in as §13 and delete this
file, or link to it. Do not maintain two competing normative specs.

This spec answers the two board rejections recorded on TNG-87 (2026-09-10T01:37Z):

> "make the live composer editable, so that I can drag-in a new agent in case I need to
> modify the pipeline. Second thing, there are some overflow issue in the node UI and the
> historical run UI."

It is written against the current candidate: `docs/mockups/prototype.{html,css,js}`,
`tokens.css`, commit `9959255`.

---

## 0. The constraint that shapes everything

`Run NN` is **one immutable attempt** (§12.2). §12.4 freezes the prompt, spine, and accepted
evidence on every terminal state. So the honest answer to "can I drag an agent into a
running pipeline?" is:

> **You edit the pipeline, not the attempt.** A dropped agent is a *staged edit to the team
> document*. It appears in the causal spine immediately, drawn as pending, and it executes
> on the next attempt.

Retroactively splicing an agent into an attempt that already ran would falsify provenance —
it would show a node in the causal chain that never produced an event. Do not do it. The
board's requirement is that the reviewer *sees the graph rewire so input flows through the
inserted agent*; that requirement is fully met by the staged-then-applied model below, and
met honestly.

This is the single highest-risk decision in TNG-121. Get it wrong and the candidate is
rejected again for lying about what ran.

---

## 1. What is draggable, and where it can land

### 1.1 Drag sources

| Source | Already draggable? | Notes |
|---|---|---|
| Library › Detected harnesses | yes (`.lib-row[draggable]`) | `unavailable` rows (e.g. gemini · Not installed) are **not** draggable |
| Library › Role presets | yes | Reviewer, Researcher |
| Library › Endpoints | n/a | empty state today |

No new drag source is introduced. The existing `⠿` drag-dots affordance and the existing
`#stage.dragging` / `.ghost` machinery (`prototype.css` §10.3) are reused.

### 1.2 Drop targets — edge insertion points only

The spine accepts drops **on its edges**, never on its nodes. Every eligible spine edge
grows an insertion point while a drag is in progress: a 24 px hit target centred on the edge
midpoint, rendered as a dashed capsule bearing a `+`.

Eligible edges in the live/idle pipeline:

| Insertion point | Resulting rewire |
|---|---|
| `Run NN ─assigns lead─► Agent A` | new agent becomes lead; former lead is delegated to |
| `Agent A ─delegates review─► Agent B` | `A ─delegates to─► C ─delegates review─► B` |
| `Agent B ─responds with─► Output` | `B ─delegates to─► C`; C becomes the inferred responder only when the team has no explicit `responder` |

**Ineligible, and each must state its reason** (§1.4): the `Prompt` node and its outgoing
edge, evidence nodes and evidence edges, the `Output` node interior, any `Previous branch`
subtree, and everything in replay mode.

### 1.3 Drag states

Four states, all required, all distinguishable without colour alone:

1. **Idle** — insertion points absent. No permanent `+` clutter on the spine.
2. **Dragging** — `#stage.dragging`. All eligible insertion points fade in (120 ms,
   `--t-quick`); the source row dims to `.node.dragging` opacity `.85`; the cursor carries a
   276 × 96 ghost preview at 60% opacity.
3. **Valid drop** — the hovered insertion point fills with `--color-accent-tint`, its border
   goes solid `--color-accent-fill` at 1.5 px, the two edges it would split render dashed to
   preview the split, and a label under the cursor names the outcome in causal language:
   *"Insert between Agent A · lead and Agent B · responder"*.
4. **Invalid drop** — `--color-alert` 1.5 px border, `not-allowed` cursor, and a reason chip:
   *"Evidence is observed, not configured"* / *"This attempt is finished — edits apply to the
   next run"* / *"Replay is read-only"*. Never a silent no-op.

Gold stays scarce: accent marks *the one* hovered target, not all of them. Non-hovered
eligible targets stay `--color-hairline` dashed.

### 1.4 On drop

1. The agent is spliced into the spine at that position, drawn **pending**: 1 px dashed
   `--color-accent` perimeter, both its edges dashed, and a literal badge `Pending · runs next`.
   Pending is never blue — blue is live-only (§12.5).
2. The spine rewires immediately and visibly. Prompt → Run → … → **C** → … → Output reads as
   one sentence with the new agent in it. Evidence already attached to A and B stays attached
   to A and B; the new agent has no evidence, and shows *"No activity yet"*, not an empty box.
3. The document switcher goes dirty — `n lines differ` (§1.4 of the TNG-89 spec). This is a
   team-document edit and must be visible as one.
4. The composer's primary action becomes **Save & run** (idle/terminal) or
   **Save & re-run** (live). `Save & re-run` snapshots the current attempt as a
   `Previous branch` and starts `Run NN+1`; branches never merge (§12.4).
5. Focus moves to the newly inserted node. Live region (polite) announces:
   *"Reviewer inserted between Agent A · lead and Agent B · responder. Pending — runs next.
   Pipeline now 3 agents."*

### 1.5 Undo

`⌘Z` removes the most recent staged insertion, restores the prior edges, returns focus to
the originating library row, and announces *"Insertion undone. Pipeline back to 2 agents."*
Undo is required — a drop that can only be reversed by reloading is not an edit.

---

## 2. The keyboard path — required, not a courtesy

Pointer drag has a first-class keyboard equivalent. It is not a fallback; it is the same
model driven by keys.

Library rows become native `<button>`s with `aria-roledescription="draggable agent"` and a
persistent hint on focus: *"Space to place"*.

| Key | In library row | In placement mode |
|---|---|---|
| `Space` / `Enter` | enter **placement mode** | commit at the current insertion point |
| `↓` / `→` | — | next insertion point, downstream |
| `↑` / `←` | — | previous insertion point, upstream |
| `Esc` | — | cancel, focus returns to the library row |
| `Tab` | leave the row | **trapped** — placement mode owns the tab key until commit or cancel |

Placement mode:

- Sets `#stage.placing`, showing the same insertion points as a pointer drag.
- The current insertion point takes the same **valid drop** treatment as pointer hover, plus
  a 2 px `--lw-node-ring` focus ring, so a sighted keyboard user sees exactly what a pointer
  user sees.
- Each move announces the target in full causal language via an `aria-live="assertive"`
  region: *"Insertion point 2 of 3. Between Agent A · lead and Agent B · responder."*
- Commit runs the identical code path as drop, including §1.4 focus and announcement.
- The stage scrolls the current insertion point into view; placement never targets an
  off-screen point silently.

Focus is never lost: cancel returns to the source row, commit lands on the new node. Both are
tested cases, not assumptions.

---

## 3. Overflow containment

Two distinct bugs were reported. They have two distinct root causes; fixing one does not fix
the other.

### 3.1 Root cause A — the node box is vertically fixed and spills

`prototype.css:336` — `.node { width: 276px; height: 96px; }`. A **fixed** height, and
`.node` declares **no `overflow` property at all**, so `overflow` is `visible`: content taller
than 96 px does not clip, it *spills outside the card border* onto the canvas.

Horizontal truncation inside the node is already correct — `.node-name`, `.node-role`,
`.node-task span:last-child` and `.node-meta .model` all carry `min-width: 0` plus ellipsis,
and `middleTruncate()` owns the model string. **Do not "fix" that; it is not the bug.**

The vertical stack is the bug. `.node-top` and `.node-meta` are `flex: none`, so they cannot
shrink; once the stack exceeds 96 px it overflows. This bites at 200% text zoom today, and
§1.4's `Pending · runs next` badge will push a normal node over the line — so this must be
fixed *before* the badge lands, not after.

The deterministic absolute layout (`--x`/`--y`, §3.1) depends on predictable node geometry,
so the fix is not to let desktop nodes grow freely:

- **Desktop graph:** `min-height: 96px; height: auto`. Geometry stays 96 px for all normal
  content; a zoomed or translated string grows the box instead of spilling. Slight
  edge-anchor drift is the correct trade against text escaping its card.
- **Narrow / stacked layout (≤ 700 px):** nodes are in flow. `height: auto; min-height: 96px;
  width: 100%; max-width: calc(100vw - var(--sp-6))`.
- Never reach for `overflow: hidden` on `.node`. It converts a visible bug into silent
  truncation of provenance, which is worse.

### 3.2 Root cause B — the history popover has no vertical bound at desktop

`prototype.css:1368` — `#history { width: 380px; }`. No `max-height`, no `overflow-y`. The
narrow breakpoint (line ~1678) does set `max-height: calc(100vh - 128px); overflow-y: auto`,
which is why this reproduces on desktop and not at 390 px. With enough retained runs the
popover simply grows past the viewport and the oldest rows become unreachable.

`.hrow` itself is already correct — `.hrow .goal` has `flex: 1; min-width: 0` + ellipsis and
`.hrow .when` is `flex: none`. The row is not the problem; the container is.

### 3.3 Clamping rules, by field

| Field | Rule | Full value recoverable via |
|---|---|---|
| Agent / node name | 1 line, `text-overflow: ellipsis` | `aria-label`, details inspector |
| Task title | 2 lines, `-webkit-line-clamp: 2` | details inspector |
| Path, command, URL | 1 line, **middle or start** ellipsis — the tail carries the meaning (`…/bin/claude`, not `/Users/me/Library/Appl…`) | details inspector |
| Evidence subtitle | 1 line, ellipsis | details inspector |
| Prompt node text | 4 lines clamped, with `Original kept` | expand control; the verbatim prompt is never destroyed (§12.2) |
| Output / response body | bounded internal scroll, `max-height: 40vh` | — |

Truncation is presentation-only. The `aria-label` always carries the full string, so a screen
reader is never truncated. `title=` is not sufficient — it is unreachable by keyboard and
touch.

### 3.4 Bounded internal scrolling — where it is allowed

Allowed: the details inspector, the historical-run list, the response body, and the evidence
list under an agent.

**Not allowed: the node card itself.** A scrolling card hides provenance behind a gesture and
breaks the causal spine's at-a-glance reading.

### 3.5 The historical-run UI

The reported second symptom. Required, on top of the §3.2 container fix:

- `#history` gets `max-height: min(60vh, 480px); overflow-y: auto` at desktop, matching the
  bound the narrow breakpoint already applies.
- **Sticky header**, so the list stays identifiable once it scrolls.
- Each run row keeps its existing `flex: 1; min-width: 0` goal column and `flex: none`
  trailing column — already correct, do not rework it.
- Row height becomes `min-height: 44px; height: auto` so a wrapped state chip cannot collide
  with the timestamp at 200% zoom.
- At 390 px the popover is already a full-width sheet; verify the trailing column drops to a
  second row rather than shrinking below legibility.

### 3.6 Widths, themes, and zoom to check

Both **Quarry Light** and **Obsidian & Gilt**, at **1440**, **1024**, **768**, and **390** px,
plus **200% text zoom** at 1440. In every combination: no clipped text, no horizontal page
scroll, no control/text collision, and every primary target ≥ 44 px (§12.5).

---

## 4. Acceptance — how this revision fails

Continuing the numbering in `TNG89_INTERACTION.md`:

29. A dropped agent alters an attempt that already produced events, or appears in accepted
    provenance without an event. **Fail.**
30. Drop is possible on evidence nodes, the Prompt, or a `Previous branch`. **Fail.**
31. An invalid drop is a silent no-op with no stated reason. **Fail.**
32. The pipeline edit is visible only in explanatory copy, not in the primary live-canvas
    story. **Fail.**
33. There is no keyboard path to insert an agent, or it does not show the same valid-target
    state a pointer user sees. **Fail.**
34. Focus is lost after drop, cancel, or undo. **Fail.**
35. A staged insertion cannot be undone. **Fail.**
36. Pending/staged state is drawn in live blue. **Fail.**
37. Any node spills or clips text, the history popover grows past the viewport, or any width
    produces horizontal page scroll — in either theme at 1440/1024/768/390 or at 200% zoom.
    **Fail.**
38. Truncated text is unrecoverable — absent from both `aria-label` and the inspector. **Fail.**
39. A node card scrolls internally. **Fail.**

---

## 5. Backend and schema assumptions — design only, do not implement

- Inserting an agent is a **team-document edit**. It writes to the team YAML through the
  existing dirty/Save path. It does not write runtime nodes to YAML (§12.6).
- Applying an edit to a *running* attempt is **not authorized** by the current contract and is
  not designed here. `Save & re-run` — snapshot the branch, start `Run NN+1` — is the only
  path, and it reuses retry lineage (`retryOfRunId`) already specified in §12.6.
- Admitting an agent to an in-flight attempt would need a new authenticated mutation plus a
  membership-change event. Neither exists. If the board wants it, it is a contract change and
  a separate issue.
- No change to `team.schema.yaml` and no amendment to the frozen WebSocket schema.

---

## 6. What this spec deliberately does not decide

- Where the inserted agent's model, budget cap, and permissions come from beyond the role
  preset's defaults — the inspector already owns that, and the drop should not grow a
  configuration dialog.
- Multi-select or multi-agent drag. One agent per drop.
- Reordering or removing existing agents by drag. The board asked for insertion; deletion
  stays with the existing node control.
- Parallel (fan-out) insertion. Every insertion point in §1.2 is sequential. Fan-out is a
  larger graph-semantics change and should not ride along with this fix.
