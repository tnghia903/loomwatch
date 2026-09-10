# LoomWatch — TNG-122 freeform capability composer revision

Revision 1 · 2026-09-10 · **design artifact only**

This revision supersedes the fixed insertion-lane interaction in
[`TNG121_EDITABLE_PIPELINE.md`](TNG121_EDITABLE_PIPELINE.md). It extends the visual and
runtime story in [`TNG89_INTERACTION.md`](TNG89_INTERACTION.md) without implementing or
authorizing a production UI, endpoint, persisted schema, or event change.

## 1. Product recommendation

Make the canvas a direct-manipulation composer. The prompt/goal is the immutable graph origin;
the response/output is the terminal result. Users place authorized workspace resources at any
unoccupied canvas position, move them freely, and explicitly wire typed relationships. A fixed
lane may remain as an optional auto-layout, but it must not be the editing model.

The Library is a workspace-scoped capability index, not a global marketplace. It enumerates only
resources the current workspace is allowed to discover: Agents, Skills, Tools / Connectors, and
Knowledge Sources. A discoverable but temporarily unusable item remains visible with its reason
(permission required, disconnected, or unavailable); a globally hidden or unauthorized resource
is omitted and represented only by an aggregate privacy note. This keeps discovery useful without
turning the library into an inventory leak.

## 2. Composition and progressive disclosure

The desktop composition is primarily an **Operate** surface: direct placement, selection,
wiring, and correction are the dominant jobs. Capability discovery is a secondary **Explore**
mode, while the connection strip and inspector provide focused **Command / Inspect** behavior:

- a 320 px collapsible Library at left: search, one category filter, one state filter, category
  disclosure rows with visible/total counts, then draggable results;
- the freeform canvas in the remaining space: prompt origin, agents and capabilities, response
  terminal, typed planned edges, and a separate observed-runtime layer;
- a compact bottom connection strip: selected object, valid actions, selected edge removal,
  replay, and non-destructive validation messages;
- the existing inspector at right for details and permission context.

Collapsed categories retain their counts. Search opens only categories with matches and preserves
the user's prior collapse choices when cleared. Empty search, empty category, disconnected, and
permission-required states are shown in context. Counts describe the authorized workspace view,
not a global catalog. Long libraries virtualize rows in production; the prototype demonstrates the
information architecture and progressive disclosure without pretending to be a performance test.

## 3. Freeform placement and movement

### Pointer

1. Drag an enabled Library row anywhere over the canvas. A ghost uses the resource's real node
   dimensions; the canvas highlights as the valid drop region.
2. Drop to place at that coordinate, clamped only to keep the full node on-canvas. No lane or slot
   is required.
3. Drag a placed node body to move it. Connected edges redraw continuously.
4. A disabled row cannot start a drag; its reason remains readable and no work changes.

### Keyboard equivalent

1. Focus an enabled Library row and press `Enter` or `Space` to arm placement.
2. A visible ghost starts at the next open grid point. Arrow keys move by 16 px; `Shift` + arrow
   moves by 64 px. `Enter` commits and focuses the new node; `Esc` cancels and restores focus to
   the Library row.
3. Focus a placed node and press `M` to move it with the same arrow/commit/cancel model.

A polite live region announces arm, movement, placement, cancellation, refusal, connection,
reconnection, and removal. Focus never falls back to `body` after a rerender.

## 4. Typed connection model

Every node exposes a right output handle and/or left input handle according to type. Pointer users
drag from an output handle to a candidate node. Keyboard users focus the source and press `W`, use
`Tab` or arrow keys to cycle targets, then `Enter` to connect. Selected edges expose `R` to retarget
the endpoint and `Delete`/`Backspace` to remove. Reconnection is atomic: the old edge remains until
a valid replacement is committed; `Esc` restores it unchanged.

Valid planned relationships in this revision:

| From | To | Relationship label |
|---|---|---|
| Prompt / goal | Agent | `starts` |
| Agent | Agent | `hands off` |
| Agent | Skill | `uses skill` |
| Agent | Tool / Connector | `invokes` |
| Agent | Knowledge Source | `reads` |
| Agent | Response / output | `produces` |
| Observed evidence | Response / output | `supports` (runtime only) |

All other pairs are refused with a specific explanation. Examples: the prompt can only start an
agent; capabilities attach to agents rather than to each other; response is terminal; a duplicate
edge already exists. Refusal never deletes, detaches, or rewrites an existing node or edge.

## 5. Planned intent versus observed evidence

The configured graph is editable **intent**: opaque cards, neutral solid warp edges, relationship
labels, and explicit dirty/save semantics. It says what the operator wants the team to be able to
do. It never claims that a capability ran.

The runtime overlay is immutable **evidence** derived automatically from accepted live events:
actual tool calls, commands, searches, files, repositories, knowledge access, recorded skill use,
handoffs, and output ownership. Runtime entities use tinted/ringed cards, ordered timestamps, owner
labels, capture/status words, and the existing blue-live/gold-observed treatment. Completed and
replayed evidence is static. Moving or deleting planned nodes never rewrites history; replay never
re-executes. Evidence-to-output links are projected from events, never authored as configuration.

Only a running agent receives the animated blue perimeter. Reduced motion replaces it with a
static 2 px blue perimeter and removes traveling/shuttle animation while preserving the `RUNNING`
word and status glyph. Success, error, cancelled, disconnected, and replay retain their established
semantic shape + word + color combinations. Gold remains scarce emphasis.

## 6. Permissions and compatibility

Library rows combine three independent facts:

- availability: ready / disconnected / unavailable;
- authorization: workspace-authorized / permission required;
- compatibility: valid destinations for the currently selected or armed source.

Permission-required resources are discoverable only when their metadata is authorized for this
workspace. They may be placed and wired so intent can be reviewed, but the planned edge carries a
`needs approval` badge and execution must stop at the permission gate. Disconnected resources are
visible but cannot be placed or wired. Compatibility guidance is contextual: valid targets gain a
label and outline; invalid targets remain inspectable and explain why instead of disappearing.

## 7. Narrow layout and overflow

At 390 px the fixed coordinate canvas becomes a source-ordered reading column. Library filters and
category disclosures remain reachable in a drawer; drag becomes the keyboard/tap placement flow;
node coordinates and Bézier edges yield to explicit relationship sentences. The prompt remains
first and response last. Planned intent and observed evidence retain separate headings. The composer
stays viewport-docked, hit targets are at least 44 px, and no fixed-width panel can widen the page.

## 8. Backend and schema assumptions — design only

The prototype assumes, but does not implement or authorize:

1. A workspace-scoped capability discovery response containing stable resource ID, display name,
   type (`agent|skill|tool|knowledge`), category, availability, authorization/permission state,
   compatibility descriptors, and safe summary metadata. It must omit globally hidden and
   unauthorized resources rather than mark them as hidden rows.
2. Persisted planned graph entities beyond today's agent-only team schema: stable capability-node
   IDs, node type/reference, typed edges, and layout positions. Recommended persistence remains a
   versioned `<team>.layout.json`/composer sidecar until an ADR deliberately changes
   `team.schema.yaml`; the design does not silently overload configured `sequence` edges.
3. A validation service or ruleset capable of returning typed relation validity and a safe,
   user-facing refusal reason. The client can preflight for responsiveness; the server remains
   authoritative at save/run.
4. Permission grants are separate security objects. A planned edge may reference a capability but
   cannot grant access. Execution requires current authorization, and revocation must invalidate
   future use without rewriting historical evidence.
5. Observed provenance continues through the existing run/provenance contract. No new hidden
   reasoning payload is requested, inferred, stored, or displayed. Tool, command, file, repository,
   search, knowledge, skill, and response evidence appear only when canonical accepted events support
   them.

The frozen WebSocket schema remains untouched. Any new discovery, validation, layout, planned-edge,
or permission contract requires backend ownership, threat modeling, schema/ADR review, and fixtures
before production implementation.

## 9. Prototype self-check contract

The standalone review artifact must prove: arbitrary-coordinate placement; node movement; typed
edge create/select/retarget/remove; non-destructive invalid-pair refusal; pointer and keyboard parity;
search, category/state filters, collapsed groups, counts, empty results, disconnected and
permission-required rows; distinct planned/runtime layers; live-to-terminal continuity; replay;
Quarry Light and Obsidian & Gilt; 1600×1000 and 390 px; reduced motion; and zero network/local
dependencies after generation.

Any loss of prompt-to-output continuity, accepted evidence, original edges after a cancelled/invalid
rewire, keyboard focus, or unsaved planned work is a release-blocking prototype failure.
