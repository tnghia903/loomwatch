# LoomWatch — Canvas interaction & visual specification

Revision 1 · 2026-09-07 · **the spec Phase 04 builds against**

Verified against `schemas/team.schema.yaml`, `docs/TEAM_CONFIG.md`, `docs/WEBSOCKET_SCHEMA.md`
and the REST surface shipped in TNG-52 (`crates/loomwatch-backend/src/api.rs`) at commit
`1bd6b1c`. Where this spec states a schema constraint or an endpoint shape, it is quoting
one of those, not proposing it.

This document owns the "look and feel" obligation ARCHITECTURE.md §6 assigns to Phase 04.
It specifies the web UI `loomwatchd` serves: layout, the agent panel, the agent node, both
edge layers, canvas mechanics, execution-mode framing, YAML round-trip, and first run —
plus a visual language concrete enough to implement in Tailwind without re-deciding
anything.

**Governing documents.** [ARCHITECTURE.md](ARCHITECTURE.md) §5 (canvas and configuration)
and §6 (client); [ADR 0003](decisions/0003-web-ui-served-by-the-daemon.md) (web UI, not a
native app); [`schemas/team.schema.yaml`](../schemas/team.schema.yaml) (the frozen config
contract); [TEAM_CONFIG.md](TEAM_CONFIG.md) (semantic rules the UI must validate against);
[WEBSOCKET_SCHEMA.md](WEBSOCKET_SCHEMA.md) (frozen — the observed layer is derived from it
and this spec does not ask it to change).

**Scope.** Configuration only. Writes to running execution — approving, pausing, or
commenting on an agent mid-run — are deferred by ARCHITECTURE.md §6 and are not designed
here. Phase 05 surfaces (observed edges live, timeline scrubber, attention queue,
notifications) are specified only to the extent Phase 04 must reserve room for them; §14.

**Where this spec stops.** Anything that would require a change to
`schemas/team.schema.yaml`, the frozen WebSocket schema, or a new daemon endpoint is
recorded in §15 (Open decisions) as an operator/backend call, not silently designed around.

---

## 0. What changed, and what that costs

Revisions 0.1–0.3 of ARCHITECTURE.md specified a native macOS SwiftUI client. ADR 0003
reversed that. The design consequences, so nobody looks for them later:

| Dropped with the native shell | Replacement in this spec |
|---|---|
| `MenuBarExtra` ambient status | None in v1. Deferred to a possible tray helper (ADR 0003 §5). §14 keeps the attention queue in-page instead. |
| Reveal in Finder / native file picker | Path is displayed and copyable; file selection happens against a daemon-owned teams directory. §15.4 |
| Native notification centre | Web Notifications API from the PWA, permission requested lazily at the first `escalate`. §14 |
| Single fixed window size, one appearance | Resizable browser window, light **and** dark, 768 px → ultrawide. §2, §13 |
| Local fonts guaranteed present | Everything ships in `dist/`. **No CDN, no external font or asset request** — this is a local-first tool that must work with no internet. §2.3 |

Two things carry over unchanged: the canvas is a visual editor over version-controlled YAML
on disk (§5 of ARCHITECTURE), and the two edge layers must be distinguishable at a glance
(§5, and §6 here).

---

## 1. Principles

Five rules. Each is testable — if a screen violates one, it is wrong.

1. **The canvas is the product.** Chrome floats over it, never boxes it in. At any moment
   the canvas occupies ≥ 70% of the viewport, and every panel can be dismissed to reach 100%.
2. **One obvious action per state.** Empty canvas → *New team*. Dirty document → *Save*.
   Selected node → its inspector. There is never a screen with two equally-weighted
   primary buttons.
3. **Progressive disclosure, not density.** The surface shows identity and state; detail
   (`spawn.args`, `spawn.env`, guards, raw YAML, event payloads) is one deliberate click
   away. **Explicitly not Paperclip** — no multi-pane dashboards, no always-on activity
   feed, no nested tab bars.
4. **The files are the truth.** Every state that differs from disk is visibly marked, and
   writing to disk is always an explicit act the user performs. The canvas never
   autosaves.
5. **Never signal with colour alone.** Every status, edge layer and edge kind is
   distinguished by at least two of {colour, shape, stroke pattern, motion}, so the design
   survives colour-blindness, `prefers-reduced-motion`, and a greyscale screenshot.

---

## 2. Visual language

### 2.1 Direction

A **warm-neutral ground with a single cool accent.** The canvas is warm off-white (light)
or near-black (dark); panels are translucent glass that let the dot grid read through;
structure is drawn in ink; anything *live* is iris; anything that *wants the operator* is
copper. That pairing — warm paper, cool light — is what keeps it from looking like a
bootstrap admin panel without spending anything on decoration.

The motif is the loom: the configured graph is the **warp** (static, drawn, structural),
observed activity is the **weft** (moving, coloured, transient, travelling along the warp
where it agrees with it). This is a naming and animation convention, not an illustration
style. No skeuomorphism, no gradients beyond a single 6% surface sheen, no drop shadows on
text, no icon illustrations.

### 2.2 Colour tokens

The `ui/` scaffold ships **Tailwind v4** (`@tailwindcss/vite`, `ui/package.json`), which has
no JS config file — so these are declared with the `@theme` directive in `index.css`, not a
`tailwind.config.js` `theme.extend`:

```css
@import "tailwindcss";
@theme {
  --color-canvas: #F6F5F2;
  --color-iris:   #5A45E8;
  /* …one line per row below; utilities like bg-canvas / text-iris are generated */
}
```

Dark mode overrides the same custom properties under a `.dark` selector rather than
redeclaring the theme. Values below are the starting palette; **the engineer must verify
every text/surface pair at ≥ 4.5:1 (≥ 3:1 for ≥ 20 px semibold and for non-text strokes)
with a contrast checker before the first build is accepted**, and adjust lightness only —
hue and role stay fixed.

| Token | Role | Light | Dark |
|---|---|---|---|
| `canvas` | canvas ground | `#F6F5F2` | `#0E0E11` |
| `canvas-dot` | grid dot | `#DAD7CF` | `#23232B` |
| `surface` | floating panel fill (used at 72% + blur) | `#FFFFFF` | `#16161B` |
| `surface-solid` | popovers, inputs, node fill | `#FFFFFF` | `#191920` |
| `hairline` | 1 px borders and dividers | `#1A1815` @ 10% | `#FFFFFF` @ 10% |
| `ink` | primary text | `#1A1815` | `#F2F1EE` |
| `ink-2` | secondary text | `#5C574E` | `#A5A29B` |
| `ink-3` | tertiary text, disabled | `#8C867A` | `#6E6B65` |
| `stroke` | configured edge | `#8C867A` | `#6E6B65` |
| `iris` | brand, live, observed, running, focus ring | `#5A45E8` | `#8B7BFF` |
| `iris-soft` | observed `ask`, hover fills | `#8B7BFF` | `#B3A6FF` |
| `iris-deep` | observed `handoff` | `#3A2BB8` | `#6E5CF0` |
| `copper` | attention: anomaly, `waiting`, conflict | `#B85C1E` | `#E8933F` |
| `green` | `succeeded` | `#1E7A4F` | `#46C08A` |
| `red` | `failed`, destructive, validation error | `#C4342F` | `#F0605B` |
| `slate` | `stopped` | `#6B6B76` | `#8A8A96` |

**Colour discipline.** Iris and copper are the only saturated colours in the product and
they are *semantic*, never decorative: iris means "this is live or this is selected",
copper means "this needs you". A button is not iris because buttons are blue somewhere
else — the single primary action is iris because it is the live action. Green/red/slate
appear only inside status indicators and validation.

### 2.3 Typography

Self-hosted, bundled into `dist/`: **Inter Variable** (`@fontsource-variable/inter`) and
**JetBrains Mono** (`@fontsource/jetbrains-mono`, 400/500 only, latin subset). System
fallbacks `ui-sans-serif` / `ui-monospace`.

| Step | Size / line | Weight · tracking | Used for |
|---|---|---|---|
| `display` | 28 / 34 | 600 · −0.02em | first-run headline only |
| `title` | 20 / 28 | 600 · −0.01em | inspector header, dialog titles |
| `body` | 14 / 20 | 400/500 | inspector fields, panel rows, node name |
| `ui` | 13 / 18 | 500 | buttons, chips, menu items |
| `meta` | 12 / 16 | 400 | node meta row, captions, help text |
| `micro` | 11 / 14 | 600 · +0.06em · uppercase | group headers, badges, counts |
| `mono` | 12 / 16 | 400 | ids, model strings, paths, YAML, tool names |

**Mono is a semantic choice, not a style:** anything the user could type into the YAML file
verbatim — agent `id`, `model`, `spawn.cmd`, `cwd`, env keys — is set in mono. Prose is
never mono.

### 2.4 Space, radius, elevation

- **Space:** 4 px base. Use only 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Panels are inset
  16 px from the viewport edge; panel padding 16 px; row height 40 px; 8 px between rows.
- **Radius:** `sm` 6 px (inputs, small buttons) · `md` 10 px (rows, cards) · `lg` 14 px
  (floating panels, nodes) · `full` (pills, chips, status dots).
- **Elevation** — two levels only.
  - `e1` floating panels: `backdrop-blur(20px)`, `surface`/72%, 1 px `hairline`,
    `0 1px 2px rgb(0 0 0 / .04), 0 8px 24px rgb(0 0 0 / .08)`. In dark, add an inset top
    highlight `inset 0 1px 0 rgb(255 255 255 / .06)`.
  - `e2` popovers, command palette, dialogs: `surface-solid` (opaque — never blur text you
    are asking someone to read carefully), `0 2px 4px rgb(0 0 0 / .06), 0 16px 40px
    rgb(0 0 0 / .14)`.
  - There is no `e3`. Nothing stacks three deep.

### 2.5 Motion

| Name | Duration | Easing | Applies to |
|---|---|---|---|
| `instant` | 90 ms | `cubic-bezier(.2,0,0,1)` | hover, press, focus ring |
| `quick` | 160 ms | `cubic-bezier(.2,0,0,1)` | panel collapse, inspector slide, tooltip |
| `move` | 240 ms | `cubic-bezier(.2,0,0,1)` | mode change, node drop settle, auto-layout |
| `entrance` | 320 ms | `cubic-bezier(.2,0,0,1)` | first-run composition, conflict bar |
| `flow` | 1400 ms | `linear`, infinite | observed-edge dash travel |
| `breathe` | 2000 ms | `ease-in-out`, alternate | running-node halo |

Exits use `cubic-bezier(.4,0,1,1)` at 0.75× the entrance duration. Nothing animates
position and opacity and scale at once; pick two.

`prefers-reduced-motion: reduce` — see §12.2. The observed/configured distinction must not
depend on motion, which is why §6 gives it four independent channels.

### 2.6 Iconography

`lucide-react` (MIT, tree-shaken, bundled). 16 px / stroke 1.5 in panels, 20 px / stroke
1.5 on nodes. No other icon set, no custom illustration.

**Harness marks are monograms, not logos.** A 20 px `rounded-md` chip with 1–2 mono
characters, so LoomWatch ships no vendor trademark art. Keyed on the `id` returned by
`GET /api/harnesses`:

| Harness `id` | Name | Monogram | `spawn` |
|---|---|---|---|
| `claude` | Claude | `C` | `claude-agent-acp` |
| `codex` | Codex | `Cx` | `codex-acp` |
| `gemini` | Gemini | `G` | `gemini --acp` |
| `opencode` | OpenCode | `Oc` | `opencode acp` |
| — | custom endpoint | `·` | user-supplied |

**The chips are not coloured.** `ink-2` monogram on a `hairline` fill, in both themes. A
per-vendor hue would put saturated colour on the screen that means nothing, which §2.2
forbids — iris and copper are semantic and spending them on branding devalues them
everywhere else. Four distinct monograms are enough to tell four harnesses apart, and it
keeps the Library monochrome so the canvas is the only place colour appears.

Role glyphs on nodes come from a fixed lucide map keyed by a lowercase substring of
`Agent.role`, with `Circle` as the fallback: `research`→`Telescope`, `review`→`ScanEye`,
`write`/`author`→`PenLine`, `test`/`qa`→`FlaskConical`, `build`/`engineer`→`Hammer`,
`plan`/`lead`→`Compass`, `design`→`Shapes`. The glyph is decoration with a hint of
meaning; nothing depends on it.

---

## 3. Overall layout

One full-bleed canvas. **Five floating elements, no docked chrome, no title bar, no menu
bar, no tab bar.** Everything else is summoned (⌘K) or conditional (inspector).

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ 16px inset                                                                    │
│  ┌─ LIBRARY ─────────┐        ┌──────────────────────────────┐                │
│  │ 288 px            │        │ ● research-team.yaml         │  ← document    │
│  │ collapsible → 48  │        │   Unsaved changes      ⌘S    │     chip       │
│  │                   │        └──────────────────────────────┘   (top centre) │
│  │                   │                                                        │
│  │                   │         ┌───────────────┐        ┌── INSPECTOR ──┐     │
│  │                   │         │  agent node   │        │ 320 px        │     │
│  │                   │         └───────┬───────┘        │ only when     │     │
│  │                   │                 │                │ something is  │     │
│  │                   │                 ▼                │ selected      │     │
│  │                   │         ┌───────────────┐        │               │     │
│  │                   │         │  agent node   │        │               │     │
│  └───────────────────┘         └───────────────┘        └───────────────┘     │
│                                                                               │
│                        ┌────────────────────────┐              ┌───────────┐  │
│                        │ ⇉ Pipeline · 2 steps   │              │ −  +  ⤢ ▣ │  │
│                        └────────────────────────┘              └───────────┘  │
│                             mode pill (bottom centre)        view controls    │
└───────────────────────────────────────────────────────────────────────────────┘
```

| Element | Position | Size | Presence |
|---|---|---|---|
| **Library** | top-left, inset 16 | 288 × `calc(100% − 32px)`, max 640 tall then scrolls | persistent, collapsible to a 48 px rail (⌘\\) |
| **Document chip** | top-centre, inset 16 | auto × 40, min 260 | always |
| **Inspector** | top-right, inset 16 | 320 × `calc(100% − 32px)` | only while exactly one node or edge is selected |
| **Mode pill** | bottom-centre, inset 16 | auto × 36 | always |
| **View controls** | bottom-right, inset 16 | 132 × 36 | always; fades to 40% after 2 s idle, full on hover |

All five are `e1` glass. The canvas beneath is never occluded by a modal except for the
parse-failure dialog in §9.5 — **the only modal in the product**, and only ever shown when
there is no canvas behind it to occlude.

**Z-order:** grid → configured edges → observed edges → nodes → handles → connection
preview → floating panels → popovers/palette → conflict bar → dialogs.

**No status bar, no breadcrumb, no toolbar.** If an action is not one of the five elements
above, it lives in the command palette (§11) or a context menu.

---

## 4. Library (the agent panel)

ARCHITECTURE §5: "detected harnesses (discovered on `PATH`), configured endpoints, and
saved role presets." Three groups, in that order, each a disclosure section with a `micro`
header and a count. All three open by default; open/closed state persists per browser.

```
┌─ LIBRARY ────────────────── ⌘\ ─┐
│  ⌕ Filter                        │   32px search, appears only when
│                                  │   the three groups total > 8 rows
│  DETECTED HARNESSES          3   │
│  ┌────────────────────────────┐  │
│  │ [C ] Claude              ⠿ │  │   40px row, grab cursor
│  │      claude-agent-acp      │  │   mono subtitle = spawn.cmd + args
│  ├────────────────────────────┤  │
│  │ [Oc] OpenCode            ⠿ │  │
│  │      opencode acp          │  │
│  ├────────────────────────────┤  │
│  │ [G ] Gemini              ⠿ │  │
│  │      gemini --acp          │  │
│  └────────────────────────────┘  │
│  ▸ Not installed             1   │   collapsed by default
│                                  │
│  ENDPOINTS                   0   │
│  ┌────────────────────────────┐  │
│  │ Nothing here yet.          │  │
│  │ Add an endpoint to reach a │  │
│  │ model without a first-party│  │
│  │ harness.                   │  │
│  │            [ Add endpoint ]│  │
│  └────────────────────────────┘  │
│                                  │
│  ROLE PRESETS                2   │
│  │ ◇ Reviewer               ⠿ │  │
│  │   claude-opus-5 · $5       │  │
│  │ ◇ Protocol Researcher    ⠿ │  │
│  │   k3-256k · $5             │  │
└──────────────────────────────────┘
```

### 4.1 Row anatomy

40 px tall, 10 px radius, transparent → `iris`/6% on hover, `grab` cursor.
`[monogram] · name (body/500) · subtitle (mono/12, ink-2, truncated middle for paths) ·
drag affordance (⠿, ink-3, 0% → 60% opacity on hover)`.

Rows are **drag sources only**. Clicking a row does not select it and does not open
anything; there is no second interaction to learn. A row's full detail is a hover tooltip
after 500 ms (`spawn.cmd`, resolved absolute path, version string if the daemon reports
one).

### 4.2 Not-installed harnesses

LoomWatch knows four first-party harness names (ARCHITECTURE §1). Any it does not find on
`PATH` goes into a collapsed **"Not installed (n)"** disclosure under the detected group —
present, because knowing `codex-acp` is a thing LoomWatch supports is useful; collapsed,
because it is not actionable right now.

**How the UI knows.** `GET /api/harnesses` returns *only* what it found — one
`{id, name, command, executablePath, spawn:{cmd, args}}` per detected harness, no entry
for the rest. So the not-installed list is a **client-side difference** against the four
`id`s in §2.6, which the UI holds as a constant. That constant is the only vendor knowledge
in the client and it changes only when the daemon's `HARNESSES` table does; §15.3 proposes
folding it into the endpoint so the two cannot drift.

Inside, rows render at 45% opacity, `cursor: not-allowed`, no drag handle, and a `meta`
line `not found on PATH`. Dragging is prevented (`draggable={false}`), and a drag attempt
shakes the row 4 px (`instant`, disabled under reduced motion) with a tooltip naming the
binary. **LoomWatch never offers to install anything** and never links to a vendor
download; it reports what it found.

### 4.3 Empty states

Each group has its own, in a dashed-hairline `md` box with `meta` text and at most one
action:

- **Detected, none found:** "No agent harnesses found on `PATH`." + a `Show search path`
  link disclosing the four binary names the daemon looks for (`claude`, `codex`, `gemini`,
  `opencode`) and the `PATH` it searched. This is the single most likely first-run failure;
  it must name the cause, not say "nothing here". **The daemon does not currently report
  its search `PATH`** — until §15.3 adds it, the disclosure lists the four names and says
  *"searched the `PATH` `loomwatchd` was started with"* rather than inventing a value. Do
  not fall back to the browser's idea of a path; there isn't one.
- **Endpoints, none:** copy as drawn above + `[ Add endpoint ]`.
- **Presets, none:** "Save any node as a preset to reuse it." No button — the action lives
  on the node's context menu, and pointing at a button that opens nothing is worse than
  pointing at the real path.

### 4.4 Collapsed rail

48 px wide, three stacked 32 px icon buttons (one per group) plus the expand chevron.
Clicking a group icon expands the panel with that group scrolled into view. Dragging is not
possible from the rail — the rail is a wayfinding affordance, not a compact library.

### 4.5 Drag to instantiate

1. **Pick up.** Row lifts to `e2`, scales 1.02, cursor `grabbing`. A 264 × 88 ghost node
   at 70% opacity follows the pointer, using HTML5 drag with
   `dataTransfer.setData('application/loomwatch-source', …)`.
2. **Over the canvas.** The ghost snaps to the 8 px grid. Node handles on existing nodes
   light to `iris`/40% — a drop can be followed immediately by a connection.
3. **Drop.** Node is created at the pointer, `move`-settles from scale 0.96 → 1, and is
   selected; the inspector opens with the **name field focused and pre-selected**. This is
   the only auto-focus in the product, and it exists because a new node's default name is
   never the right one.
4. **Defaults on drop.** `id` = slugified unique name (`reviewer`, `reviewer-2`) matching
   `$defs.Identifier`; `name` = harness/preset label; `spawn` copied verbatim from the
   source row's `spawn` (`cmd`, `args`), plus `env: {}`, `cwd: "."`; `allowRecruiting: true`.
   No `budget` (retired by ADR 0027).
   `status` is **never** written (TEAM_CONFIG.md: runtime-only).

   **Two fields are deliberately left empty: `role` and `model`.** Both are `required` with
   `minLength: 1` in `$defs.Agent`, and neither has a defensible default — a role is the
   whole point of the node, and `GET /api/harnesses` advertises no models (§15.3). So a
   freshly dropped node makes the document **invalid**, `Save` is disabled, and the reason
   names the node. This is correct and intended: the alternative is a plausible-looking
   default that saves cleanly and runs the wrong model. From a **preset**, both are already
   filled and the node is valid on drop — which is the entire argument for presets.

   **The root `entrypoint` is set by the first drop.** It is a required root field naming an
   agent in `agents` (§9.2), so a document whose only agent is not the entrypoint could never
   save. Dropping into a document that has no entrypoint — a new team (§10.2), or one whose
   entrypoint was deleted (§5.4) — therefore promotes that node and shows the `ENTRY` marker
   (§5.1) immediately. This is not the kind of guess `role` and `model` refuse above: with a
   single candidate there is no decision to make. Every **later** drop leaves `entrypoint`
   alone; promotion after the first is always explicit, via the inspector (§5.4) or §6.6's
   refusal action. This is what makes §10.2 true — `role` and `model` really are the only
   things standing between a first drop and a valid save.
5. **Drop outside the canvas** — cancel, ghost returns with an `instant` fade. No dialog.

Keyboard equivalent: ⌘K → "Add agent…" → pick a source → the node is placed at the viewport
centre on the nearest free grid cell.

---

## 5. The agent node

> **As built, 2026-09-16.** Both canvases now draw one card. Build and Run ("Full trace") render
> the same `.build-node` agent card from [`BuildNodeCard.tsx`](../ui/src/components/canvas/BuildNodeCard.tsx);
> a run layers its projected task state and evidence routes under the identity row rather
> than substituting a card of its own. The `.node` anatomy specified below is no longer rendered on
> either canvas. Everything it says about *what an agent card must state* still holds — only the
> box it is stated in changed.

### 5.1 Anatomy

264 × 88 px, `lg` radius, `surface-solid` fill, 1 px `hairline`, no shadow when idle.

```
 ┌╥──────────────────────────────────────────────────┐
 │║  ⌾  Protocol Researcher                       ◐  │   ← 20px role glyph · name (body/500)
 │║     Research ACP behavior                        │   · status indicator (right)
 │║                                                  │   ← role (meta, ink-2, 1 line, truncate)
 │║ ──────────────────────────────────────────────── │
 │║  [Oc] kimi-for-coding/k3-256k                    │   ← monogram · model (mono/12, middle-
 └╨──────────────────────────────────────────────────┘        truncate)
  ▲
  3px status rail (full status colour, left edge, lg radius on the left corners only)
```

- **Name** is the identity. If `name` is long it truncates at the tail; the `id` is *not*
  shown on the node (it is in the inspector) — showing both is Paperclip density.
- **Role** is one line, `meta`, `ink-2`. Empty role renders `Add a role` in `ink-3` italic,
  which is also the only inline-editable hint besides the name.
- **Meta row** is separated by a 1 px `hairline` inset 12 px. Model middle-truncates
  (`kimi-for-…/k3-256k`) because both ends carry meaning.
- **Entrypoint marker:** the role glyph is wrapped in a 2 px `iris` ring and the node gains
  a `micro` `ENTRY` pill in the top-right, left of the status indicator. Exactly one node
  carries it (schema: `entrypoint` is required).
- **`allowRecruiting: false`** adds a 12 px `Lock` glyph in `ink-3` at the meta row's left,
  before the monogram, with tooltip "may not recruit helpers".

### 5.2 States

| State | Treatment |
|---|---|
| default | 1 px `hairline`, no shadow |
| hover | `hairline` → `ink-3`/40%, `e1` shadow, handles grow 8 → 12 px and take `iris` |
| selected | 2 px `iris` ring at 3 px offset, `e1` shadow, inspector opens |
| multi-selected | same ring at 60% opacity, no inspector (inspector shows "n selected" + bulk actions: delete, align) |
| keyboard-focused | 2 px `iris` ring **plus** a 1 px white/black inner ring so it is visible over any fill |
| invalid | 1.5 px `red` border, a `red` dot in the top-left corner; tooltip lists the failing semantic rule from TEAM_CONFIG.md |
| dragging | 0.85 opacity, `e2`, grid-snapped |

### 5.3 Status indicator

Top-right, 12 px. **Shape and colour both encode the state** — the eight values of
`Agent.status` in the schema:

| Status | Shape | Colour | Motion |
|---|---|---|---|
| `idle` | hollow ring, 1.5 px | `ink-3` | none |
| `starting` | hollow ring with a 90° arc | `iris` | arc rotates, 1200 ms linear |
| `running` | filled dot | `iris` | `breathe` halo, 10 px → 14 px, 0.35 → 0 alpha |
| `waiting` | hollow diamond | `copper` | none (it is waiting on a human; motion would imply progress) |
| `succeeded` | filled circle + check | `green` | none |
| `failed` | filled circle + × | `red` | none |
| `stopped` | filled square | `slate` | none |
| `unavailable` | dashed hollow ring | `ink-3` @ 40% | none |

The status rail on the left edge takes the same colour at full saturation, so status is
legible at zoom levels where the 12 px indicator is not (§7.3).

**In Phase 04 every node is `idle`.** The full table is specified now so Phase 05 does not
re-invent it, and so the rail/indicator space is designed into the node from the start.

### 5.4 Editing: inspector, not inline

**Recommendation — inspector panel, with exactly two inline exceptions.**

Inline editing loses to an inspector here because `spawn.args` is an ordered list and
`spawn.env` is a key–value map (schema `$defs.Spawn`). Editing either on a 264 px node
either shrinks the canvas element into a form — which is the density this product is
defined against — or resizes the node while you type, which breaks edge geometry. One
consistent place to edit is also one place to validate.

The two exceptions are the two fields whose value *is* the node's appearance:

- **Name** — double-click the name, or `Enter` on a selected node. Becomes a borderless
  input in place; `Enter` commits, `Esc` reverts, blur commits.
- **Role** — double-click the role line. Same behaviour.

Everything else is the inspector.

```
┌─ INSPECTOR ─────────────────── × ─┐
│                                   │
│  ⌾  Protocol Researcher           │  title, editable on click
│     researcher                    │  mono, ink-2 — the `id`
│                                   │
│  ─────────────────────────────    │
│  ROLE                             │
│  ┌─────────────────────────────┐  │
│  │ Research ACP behavior       │  │
│  └─────────────────────────────┘  │
│                                   │
│  MODEL                            │
│  ┌─────────────────────────────┐  │
│  │ kimi-for-coding/k3-256k   ⌄ │  │  free text; suggestions only if a
│  └─────────────────────────────┘  │  harness advertises models (§15.3)
│                                   │
│  BUDGET                           │
│  ┌────────────┐  ┌─────────────┐  │
│  │ $ 5.00     │  │ warn 80 %   │  │
│  └────────────┘  └─────────────┘  │
│                                   │
│  ☑ Entrypoint                     │  radio-like: checking it unchecks
│  ☑ May recruit helpers            │  the previous entrypoint
│                                   │
│  ─────────────────────────────    │
│  ▸ SPAWN                          │  collapsed by default
│    cmd   opencode                 │
│    args  acp                      │
│    cwd   .                        │
│    env   —                        │
│                                   │
│  ─────────────────────────────    │
│  Save as preset      Delete node  │  ui/13, ink-2; Delete is red on hover
└───────────────────────────────────┘
```

- **Spawn is collapsed by default** and shows a 4-line read-only summary when collapsed.
  Expanded, `cmd` is a text input, `args` a reorderable list of chips with `+ Add`, `cwd`
  a path input with a `relative to the team file` hint, `env` a key–value editor with an
  inline warning when a key looks like a credential (`*KEY*`, `*TOKEN*`, `*SECRET*`,
  `*PASSWORD*`): *"Team files are version-controlled. LoomWatch never stores credentials"*
  (ARCHITECTURE §1, TEAM_CONFIG.md). The warning does not block — it is the user's file.
- **Validation is live and per-field**, against the schema the daemon serves at
  `GET /api/config/schema` (§9.2) plus the TEAM_CONFIG.md semantic rules. It has **two
  weights**, and the difference matters because a new node starts life incomplete (§4.5):

  | Weight | When | Field | Node (§5.2) |
  |---|---|---|---|
  | **incomplete** | required and never filled | `copper` 1 px border, `meta` `Required` beneath | `copper` dot, no red border |
  | **error** | filled with something invalid, or still incomplete after a save attempt | `red` 1 px border, `meta` `red` message | invalid state, `red` border + dot |

  A field never turns red while the user is typing in it — it settles on blur, or on ⌘S.
  Greeting someone with red the instant they drop a node is punishing them for an action
  the product told them to take; copper says *unfinished*, red says *wrong*. Both block
  the save, so nothing invalid can reach disk either way.
- **Entrypoint is radio-like in both directions.** Checking it unchecks the previous
  entrypoint; **unchecking it directly is not possible** — the box on the current entrypoint
  is inert, because the schema has no "no entrypoint" state to move to. You promote a
  different node instead. Hovering the checked box explains that: *"Every team starts
  somewhere. Check another agent to move the entry point."*
- **Responder is explicit and radio-like in pipeline mode.** Checking “Produces the team output”
  in an agent's Inspector, or drawing from that agent to the permanent Output node, writes the root
  `responder` agent ID and moves the `responds with` edge immediately. Selecting another agent
  replaces it; later pipeline stages still execute but do not replace its canonical reply. When
  `responder` is absent, the unique terminal stage remains the compatibility default. Team mode's
  responder is its entrypoint; create a pipeline before choosing another agent.
- **Deleting the entrypoint node** is allowed and follows §4.5's rule, mirrored:
  - If **exactly one** agent remains, it is promoted automatically — one candidate, no
    decision.
  - If **two or more** remain, LoomWatch does **not** pick. `entrypoint` is left unset, the
    document is invalid, `Save` is disabled, and the problems popover (§9.2) carries
    *"This team has no entry point."* with each remaining agent as a one-click promotion.
    Silently promoting whichever node happened to be next is precisely the plausible-looking
    default §4.5 refuses: which agent starts the team decides what the team does.
  - If it was the **last** agent, the document is invalid on `agents` `minItems: 1` too, and
    `Save` carries §10.2's existing reason — *"A team needs at least one agent."* The canvas
    is simply empty: the §10.3 ghost does **not** return, by that section's own rule.

  Deleting any node also deletes its edges, so removing the last configured edge this way
  changes the execution mode on the same rules as §6.6 — the mode pill confirms inline
  rather than flipping silently.
- **Every edit is immediate in memory** — no "Apply" button. The document chip flips to
  *Unsaved changes* on the first keystroke. `Esc` closes the inspector; it does not revert.
- **Deselecting closes the inspector** with a `quick` slide-right + fade.

### 5.5 Level of detail

React Flow exposes zoom via `useStore(s => s.transform[2])`. Nodes render three ways:

| Zoom | Render |
|---|---|
| ≥ 0.6 | full (§5.1) |
| 0.35 – 0.6 | 264 × 44: status rail, role glyph, name, status indicator. Role and meta row hidden. |
| < 0.35 | 44 × 44 chip: role glyph on the status-rail colour, name as a label beneath at 11 px |

Transitions between levels are instantaneous (no cross-fade) — animating at low zoom while
panning is where a canvas starts dropping frames.

---

## 6. Edges — two layers

This is ARCHITECTURE §5's named requirement: *"configured edges (solid, drawn by the user,
real constraints) and observed edges (animated, derived from Team Bus events)"*, and it is
the hardest thing on the screen to get right.

### 6.1 The distinction, in four channels

The two layers differ on **every** channel, so any one of them can be lost (colour
blindness, reduced motion, a greyscale print) and the distinction survives:

| Channel | Configured | Observed |
|---|---|---|
| **Colour** | `stroke` (neutral ink) | `iris` family, or `copper` when anomalous |
| **Stroke** | solid, 1.5 px | dashed, pattern varies by kind |
| **Motion** | static, always | dashes travel (`flow`) |
| **Geometry** | the direct smoothstep path | offset 14 px perpendicular from the configured path, or a wider curve where none exists |

Said in one line: **structure is a quiet solid grey line; activity is a moving coloured
dashed line beside it.**

### 6.2 Visual table

| Layer · kind | Stroke | Colour | Marker | Motion |
|---|---|---|---|---|
| configured · `sequence` | 1.5 px solid | `stroke` | filled arrowhead, 8 px | none |
| observed · `dispatch` | 1.5 px dash `6 4` | `iris` | open arrowhead | `flow` → |
| observed · `ask` | 1.5 px dash `2 3` | `iris-soft` | open arrowheads **both ends** | `flow` alternating ⇄, 1400 ms each way |
| observed · `handoff` | 2.5 px dash `10 4` | `iris-deep` | double chevron ≫ | `flow` → **once** on arrival, then static (a handoff happens once) |
| observed · anomaly | 1.5 px dot `1 4` | `copper` | open arrowhead + ⚠ midpoint badge | `flow` → |

An **anomaly** is an observed edge in pipeline mode with no configured counterpart —
ARCHITECTURE §4: *"observed edges verify the design; deviation is an anomaly."* In team
mode there is no configured graph to deviate from, so nothing is anomalous and everything
observed is iris.

Selected edge: stroke +1 px, `iris` ring glow at 20%, and a midpoint pill showing
`from → to` in mono.

### 6.3 When the layers coincide

If an observed edge has the same `(from, to)` as a configured edge, **do not draw a second
edge.** Two near-parallel lines between the same pair is exactly the clutter this design
must avoid. Instead:

- The configured edge keeps its geometry and gains a **shuttle**: a 24 px `iris` segment
  travelling source → target along the same path, `flow` timing, one pass per observed
  event, queued if several arrive.
- After the pass, the configured edge holds an `iris` tint at 30% and a `micro` count badge
  (`×3`) at its midpoint for the rest of the run. This is the "the design was followed"
  signal, and it is a *confirmation*, not a new object.
- Reduced motion: no shuttle. The tint and the count badge appear immediately.

Only a *non*-coincident observed edge gets its own offset line.

### 6.4 Multiplicity and ageing

- Repeated observed events between the same pair with the same `kind` collapse into **one**
  edge carrying a `micro` count badge. They never stack.
- Same pair, different kinds → separate edges, offset 14 px and 28 px.
- Observed edges **age**: full opacity while the source node is `running`, fading to 40%
  over 4 s after its last event. The live frontier of the graph is therefore the brightest
  thing on screen without anything having to be highlighted.
- Observed edges are runtime data (TEAM_CONFIG.md) and are **never written to the team
  file**. They are cleared when a new run starts and are not restored on reload in Phase 04
  (the archive replay that would restore them is Phase 05).

### 6.5 Derivation from the frozen wire schema

Phase 05 derives observed edges from WEBSOCKET_SCHEMA §4 with no schema change:

- A bus-authored `tool_call` pair (`payload.title === "Team Bus: <tool>"`) on agent A with
  `name` ∈ {`dispatch`, `ask`, `handoff`} and `rawInput.agent === B` yields an observed edge
  A → B of that kind, `ts` = the event `ts`.
- **Only on a `tool_update` with `status: "completed"`.** A guard rejection is
  `status: "failed"` (§4.3) and **must not create an edge** — no process ever spawned, so
  no delegation happened. It produces a 600 ms `copper` refusal flash on the *source* node's
  status rail plus an attention-queue entry carrying `rawOutput.error` verbatim (§14).
- Harness echoes of the same MCP call must be ignored — match the bus-authored pair, not
  `mcp__server__tool` names (WEBSOCKET_SCHEMA §4.5).
- `report` and `roster` draw no edge; `escalate` draws no edge and sets the caller
  `waiting` + fires a notification.

Phase 04 builds the two-layer renderer against **fixture data** in this shape, so Phase 05
only has to connect the socket.

### 6.6 Drawing, typing and deleting a configured edge

**Draw.** Drag from a node's right (source) handle to another node's left (target) handle.
Strict connection mode — handles are typed, source-right / target-left, so direction is
unambiguous and there is no accidental reversal. While dragging: the preview line is 1.5 px
dashed `iris`; valid targets pulse their handle; invalid targets dim to 30%.

Drop on empty canvas → the **quick-add popover** at the drop point: a filter field over the
same three Library groups, ↑↓/Enter to choose. Choosing creates the node *and* the edge.
`Esc` cancels both. This is the fastest way to build a chain and it is worth the one extra
component.

**Fields written on draw.** The counterpart to §4.5's defaults-on-drop, and the same
constraint applies: `$defs.Edge` sets `additionalProperties: false` and requires all five of
`from`, `to`, `layer`, `kind`, `ts`, so there is no partial edge and nothing extra may ride
along. A drawn edge is committed as
`{ from, to, layer: "configured", kind: "sequence", ts: <now> }`. Only `from`, `to` and `ts`
are the UI's to choose — `layer` and `kind` are forced by the schema's `edges[].allOf`, not
picked (see **Type.** below). Unlike a freshly dropped node, a drawn edge is therefore
**always valid on creation**; edge refusals are semantic (the table above), never
schema-completeness ones.

`ts` is RFC 3339 with an explicit `Z` or `±HH:MM` offset — the schema's `pattern` rejects a
naive local timestamp, so a bare `new Date().toISOString()` is correct and
`toLocaleString()` is not. On a configured edge `ts` records **when the user drew it**, not
anything about a run, and it is stable across saves: reconnecting an endpoint (below)
preserves the original `ts` rather than restamping, so rearranging a pipeline does not churn
the diff of a version-controlled file (ARCHITECTURE §5). `ts` is never surfaced in the UI —
it exists to satisfy the schema and to keep the observed layer's shape identical (§6.5).

**Refusals**, from TEAM_CONFIG.md's semantic rules, all shown as an `e2` popover anchored
at the cursor with the reason in plain language and an action where one exists:

| Rejected | Message | Action |
|---|---|---|
| self-edge | "An agent can't follow itself." | — |
| duplicate `from`/`to` | "These are already connected." | — |
| creates a cycle | "That would make a loop: `a → b → a`. Pipelines run in one direction." | — |
| edge into the entrypoint | "`researcher` is the entrypoint, so it can't have an incoming step." | **[ Make `reviewer` the entrypoint ]** |

The popover dismisses on the next click or after 4 s. No toasts stacking in a corner — the
message appears where the user was looking.

**Type.** The schema pins configured edges to `layer: configured, kind: sequence`
(`schemas/team.schema.yaml`, `edges[].allOf`). **There is therefore no edge-kind picker in
v1** and every drawn edge is a sequence edge. The visual vocabulary for the other three
kinds exists (§6.2) so nothing is boxed in, and the interaction that would expose it — a
segmented control in the edge inspector — is specified but dormant. Opening it up is a
schema change; see §15.2.

**Delete.** Select the edge (click anywhere on it, or on its 12 px invisible hit area) and
press `Delete`/`Backspace`; or hover and click the `×` that fades in at the midpoint after
150 ms. Deleting the **last** configured edge changes the execution mode (§8.3) and is
therefore confirmed inline on the mode pill rather than silently applied. `⌘Z` undoes any
edge operation.

**Reconnect.** Dragging either endpoint of a selected edge to a different handle moves it,
re-running the same validations. Dropping on empty canvas deletes it.

---

## 7. Canvas mechanics

### 7.1 Navigation

| Action | Input |
|---|---|
| pan | two-finger trackpad scroll · middle-drag · `Space` + drag · drag empty canvas |
| zoom | `⌘`/`Ctrl` + scroll · pinch · `⌘+` / `⌘−` · view controls |
| zoom range | 0.25 – 2.0, default 1.0 |
| fit to content | `F`, or `⤢` in the view controls; 64 px padding, capped at zoom 1.0 |
| zoom to selection | `⇧F` |
| reset | `⌘0` → zoom 1.0 centred on the entrypoint |

Background: `<Background variant="dots" gap={16} size={1} />` in `canvas-dot`. The grid is
the only texture in the product; it is what makes the plane read as a canvas rather than an
empty div, and it must stay faint enough that a screenshot of an empty canvas looks
intentional rather than broken.

Minimap: **off by default**, toggled by `▣` in the view controls, bottom-right, 160 × 112,
`e1`, nodes drawn as status-coloured rounded rects. A minimap on by default is chrome for a
graph that usually has under ten nodes.

### 7.2 Placement

- `snapGrid = [8, 8]`, snapping on while dragging.
- Multi-select: marquee on empty-canvas drag with `⇧` held, or `⇧`-click.
- Alignment guides: 1 px `iris` lines when a dragged node's centre or edge is within 4 px
  of another's; no magnetic snap-to-node, only the guide.
- Collision: a node dropped fully overlapping another is offset by `+24, +24` until free.
- **Auto-layout** (`⌥⌘L`, and in the palette): `dagre`, left-to-right, `nodesep 48`,
  `ranksep 96`, animated over `move`. Available in both modes; in team mode it arranges
  the unconnected nodes into a centred grid instead of a rank layout. Always undoable.

### 7.3 Where node positions live — **operator decision required**

`x`/`y` cannot go into the team file as it stands: the root schema and `$defs.Agent` are
both `additionalProperties: false`, so adding a position field is a schema change, and
ARCHITECTURE §5 wants team design "diffable and reviewable" — position churn in the file
that reviewers read is a real cost.

| Option | For | Against |
|---|---|---|
| **A — sidecar `<team>.layout.json`**, committed alongside the team file | no schema change; positions travel with the repo and across machines; noise stays out of the reviewed file; trivially `.gitignore`-able if the operator prefers | a second file to keep in sync; needs daemon read/write endpoints |
| **B — `Agent.ui: {x, y}` in the team file** | one file, one save, always consistent | schema v1 change + ADR; every drag dirties the reviewed config; diffs get noisy |
| **C — browser `localStorage`** | zero backend work | lost on another device, and the whole point of a daemon-served UI is that it opens from anywhere (ADR 0003) |

**Recommendation: A.** Same basename, `.layout.json` extension.

**Decided 2026-09-13: option A**, in
[ADR 0016](decisions/0016-sidecar-v2-followups-and-checkpoints.md) decision 2. The file already
existed for planned capability wiring ([ADR 0011](decisions/0011-planned-capability-sidecar.md)),
so positions joined it rather than getting a second sidecar: the shape is
`{ "version": 2, "nodes": [...], "edges": [...], "agents": { "<agentId>": { "x": 0, "y": 0 } } }`,
and a version-1 file is upgraded on read. The recommended standalone shape above is not what
shipped — one sidecar per team, holding all of the operator's editable intent, is the same
decision with one fewer file to keep in sync.

**The canvas must not depend on it either way.** When no layout is available, positions come
from deterministic `dagre` auto-layout seeded by the team `id`, so the same file always
opens the same shape on any machine. Missing layout is a normal state, not an error, and it
is never surfaced to the user.

---

## 8. Execution modes

TEAM_CONFIG.md: `edges: []` → team mode, the entrypoint self-organizes; non-empty `edges` →
pipeline mode, the backend executes the DAG. This is a **consequence of the file**, not a
setting — so the UI must never render it as a toggle the user flips. It reports the mode
the file is currently in.

### 8.1 The mode pill

Bottom-centre, always present, 36 px, `e1`, `full` radius. It is the one piece of chrome
that explains the whole document.

```
   TEAM MODE                              PIPELINE MODE
┌─────────────────────────────┐     ┌──────────────────────────────┐
│ ⁂  Team · self-organizing   │     │ ⇉  Pipeline · 4 steps        │
└─────────────────────────────┘     └──────────────────────────────┘
   ink-2 text, ink-3 glyph            ink text, iris glyph
```

The pill is a **label, not a control**. It explains itself in one plain sentence on hover:

- **Team:** "Your lead agent gets the request and decides who else to bring in."
- **Pipeline:** "Your agents work one after another, in the order you connected them. Each
  one picks up where the last one left off."

**Retired 2026-10-02: the mode popover.** Clicking the pill used to open an `e2` popover
naming the Team Bus tools each mode withdraws, listing the resolved step order, and editing
`guards`. Operators don't need any of that to run a team, and the popover had no visible way
to close. It was removed, and nothing should bring it back without a user need:

- The step order is already on the canvas: every node carries its step number.
- `guards` (`maxDispatchDepth`, `maxConcurrentDispatches`, both defaulting to `8`,
  TEAM_CONFIG.md) live in the team file only. The canvas keeps them on save but no longer
  edits them. `maxConcurrentDispatches` has no effect in pipeline mode anyway, because
  `dispatch` and `handoff` are withdrawn there.
- Observed delegations with no configured counterpart stay as the pill's `⚠ n` count, with
  a plain hover hint, and are drawn on the canvas in the Run view.
- A team's `schedule:` routine (its timing, delivery, last problem and **Run now**) moved
  to the composer's note line, and to **Run routine now** in the workspace menu.

### 8.2 The two canvas states

Both states show the same nodes; the framing differs.

```
TEAM MODE — edges: []                     PIPELINE MODE — edges drawn
┌──────────────────────────────┐          ┌──────────────────────────────┐
│                              │          │   ①            ②        ③    │
│      ┌────┐    ┌────┐        │          │  ┌────┐      ┌────┐  ┌────┐  │
│      │ ⌾A │    │  B │        │          │  │ ⌾A ├─────►│  B ├─►│  C │  │
│      └────┘    └────┘        │          │  └────┘      └────┘  └────┘  │
│           ┌────┐             │          │                              │
│           │  C │             │          │                              │
│           └────┘             │          │                              │
│  handles dormant (ink-3/25%) │          │  handles active (iris/40%)   │
│  ⌾ = entrypoint ring         │          │  ① step numbers on nodes     │
│                              │          │                              │
│  ┌ ⁂ Team · self-organizing ┐│          │  ┌ ⇉ Pipeline · 3 steps ────┐│
└──────────────────────────────┘          └──────────────────────────────┘
```

- **Team mode:** no rank order is implied, so auto-layout arranges nodes as a centred
  constellation rather than a chain. Handles are dormant — visible enough to discover, quiet
  enough not to suggest the graph is unfinished. Only the entrypoint is marked.
- **Pipeline mode:** each node gains a `micro` step number in a 16 px circle at its
  top-left, from `pipeline_order()`. A **join** node (more than one configured predecessor)
  gets a `⑂` glyph next to its number with the tooltip "receives replies from `b`, `c` in
  that order" — TEAM_CONFIG.md's dataflow rule is invisible otherwise, and it is exactly
  the thing a user gets wrong.

### 8.3 The switch is an event, not a state change

Drawing the **first** edge changes how the whole team executes. That must be felt:

1. The edge draws normally (`quick`).
2. The mode pill morphs over `move`: glyph `⁂` → `⇉` with a 180° rotation, text
   cross-fades, the pill widens, and its border flashes `iris` once.
3. Step numbers fade in on every node over `move`, staggered 40 ms.
4. A single `meta` line appears under the pill for 4 s, then fades:
   *"Drawn edges now sequence this team. `dispatch` and `handoff` are withdrawn."*

Deleting the **last** edge reverses it, but is confirmed first, because it silently widens
what agents may do. The mode pill turns into an inline confirmation for 5 s — no modal:

```
┌────────────────────────────────────────────────────────┐
│ ⚠  Removing the last edge returns this team to         │
│    self-organizing.        [ Undo ]   [ Keep it ]      │
└────────────────────────────────────────────────────────┘
```

`Keep it` (or letting it time out) accepts the deletion. `Undo` restores the edge. Copper
border, `entrance` in, `quick` out.

---

## 9. YAML round-trip

Principle 4. The canvas is a **view over a file**; the file is the truth (ARCHITECTURE §5).

### 9.1 The document chip is the save-to-disk moment

Top-centre, 40 px, and the single place file state is expressed. Seven states — these six,
plus `new` below:

| State | Dot | Text | Right slot |
|---|---|---|---|
| clean | `ink-3` hollow | `research-team.yaml` | `⌘S` in `ink-3` when hovered |
| dirty | `iris` filled | `research-team.yaml` · `Unsaved changes` | `[ Save ⌘S ]` iris button |
| saving | `iris` spinner | `Saving…` | — |
| saved just now | `green` check | `Saved` (reverts to clean after 2 s) | — |
| failed | `red` × | `Couldn't save` | `[ Retry ]` · reason on click |
| invalid | `red` filled | `2 problems` | `[ Review ]` → problems popover |
| read-only | `slate` lock | `research-team.yaml` · `Read-only` | reason on click |

Clicking the filename opens an `e2` popover with the **absolute path** in mono, a
`Copy path` action, `Open another team…`, `Reload from disk`, and `Discard changes`
(destructive, `red` on hover, confirms inline). A browser cannot reveal a file in Finder;
copy-path is the honest equivalent (§15.6).

There is a seventh, transient state — **`new`**: a named document that has never been
written (§10.2). Dot `iris` hollow, text `research-team.yaml · Not saved yet`, right slot
the `Save` button, disabled until the first agent is complete. It collapses into `clean`
after the first successful save and never returns.

**Saving is always explicit.** No autosave, no save-on-blur, no debounce-write. ⌘S from
anywhere, including while an input is focused. The button is disabled while the document is
invalid, with the reason on hover — never a save that produces a file the backend will
reject.

### 9.2 Validation before save

Validate against **the schema the daemon serves** — `GET /api/config/schema` returns
`schemas/team.schema.yaml` embedded in the running binary. Fetch it once at load; do not
bundle a copy into the UI, because a bundled copy is a second source of truth that silently
drifts from the daemon that will reject the save.

Then the TEAM_CONFIG.md semantic rules the schema cannot express: unique agent ids;
`entrypoint` names an agent in `agents`; in pipeline mode the entrypoint is a source with no
incoming edge; no self-edges; no duplicate `from`/`to`; configured edges form a DAG. The problems popover lists each as `meta` text with the offending
node/edge name; clicking an entry selects and centres it on the canvas. `status` is never
serialized.

`PUT /api/team` re-validates server-side and answers `422` with a message before touching
the file, so client validation is a **courtesy, not the gate** — it exists to explain the
problem next to the field instead of after a failed round-trip. A `422` that the client
did not predict is a bug in the client's rule set: surface it in the `failed` chip state
verbatim rather than swallowing it.

### 9.3 The file changed underneath you

**How the UI finds out.** The daemon does not watch files today, and `GET /api/team`
returns `{path, yaml}` with **no revision token** — so there is currently nothing to
compare against and no push channel. §15.4 asks for both. Until they land, Phase 04
implements the weaker but honest version: hash the `yaml` string received at load, re-`GET`
on window focus and immediately before a save, and compare hashes. That catches the case
that actually happens — the operator edits the file in an editor, comes back to the tab —
without pretending to be live. **The detection mechanism is behind one function**; when the
push channel exists it is swapped there and nothing below changes.

On an external change:

- **Canvas clean** → reload silently. A `meta` chip fades in under the document chip for
  3 s: *"Reloaded from disk"*. Node positions are preserved for agents that still exist.
  No dialog — the user's work is not at risk, and interrupting them would be theatre.
- **Canvas dirty** → a `copper` **conflict bar** slides down from the top edge over
  `entrance`, full width minus 32 px, pushing nothing (it overlays):

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ⚠  research-team.yaml changed on disk while you had unsaved edits.        │
│                              [ Compare… ]   [ Keep mine ]   [ Use disk ]  │
└───────────────────────────────────────────────────────────────────────────┘
```

  - `Compare…` opens a side sheet (`e2`, 480 px, right) with a unified YAML diff, disk on
    the left, in-memory on the right, changed lines marked. Read-only. The two buttons
    repeat at its foot.
  - `Keep mine` dismisses the bar and leaves the document dirty; the next save overwrites
    disk. The bar does not reappear for that same disk revision.
  - `Use disk` discards in-memory edits after an inline confirm on the button itself
    (`Use disk` → `Discard my edits?`), then reloads.
  - **LoomWatch never merges.** Three-way merge of a config file is a silent-corruption
    machine; the user picks a side.
- **File deleted or renamed** → the canvas stays, becomes read-only, and the chip reads
  `File is gone`, offering `Save a copy…`.

### 9.4 A save that would reformat — **resolved: it doesn't**

Earlier revisions of this spec specified a modal warning that saving rewrites the file. It
is **withdrawn**, because the round-trip turned out to be faithful on both sides:

- `TeamFileModel` (TNG-53, `ui/src/lib/team-file/document.ts`) wraps a CST-preserving
  `yaml.Document`, so untouched fields keep their original formatting, comments and key
  order across load → edit → save.
- `PUT /api/team` writes the submitted string via `atomic_write` (temp file + atomic rename) — **verbatim bytes**. The
  daemon does not re-serialize, so it contributes no reformatting of its own.

A save therefore changes the lines the user changed, and leaves the rest alone. That is what
a version-controlled file deserves, and a modal warning about damage that no longer occurs
would be worse than nothing — it would teach the operator to click through warnings.

**What replaces it:** the chip popover carries one `meta` line, *"Saves keep your comments
and key order."* Not a dialog, not a first-save gate. And `Show YAML` (§11) remains the
checkable version of the claim at any moment.

**This holds only as long as the two properties above do.** If either the client model or
the daemon's write path is ever changed to canonical re-serialization, the warning comes
back and this section is the reason it should. A test asserting that a load/save cycle with
no edits is byte-identical belongs with `TeamFileModel`, not in the UI.

**One case still reformats and must be honest about it:** a file whose *structure* the user
edited on canvas — reordering agents, deleting one — moves or drops the comments attached to
those nodes, because the comment travelled with the mapping. No dialog; the diff in
`Show YAML` is the disclosure, and `git diff` is the operator's real safety net.

Consequence for §3: there is now exactly **one** modal in the product, §9.5's parse-failure
dialog.

### 9.5 Version and read-only

`schemaVersion` other than `1` → the canvas opens **read-only** with a persistent `slate`
bar: *"This file uses schema version 2. This build of LoomWatch understands version 1."*
No editing, no save, panning and inspection allowed. TEAM_CONFIG.md requires readers to
reject versions they do not understand rather than guess; the UI's job is to make that
legible instead of showing a parse error.

A file that cannot be parsed at all → **the product's only modal**: the parse error, the
offending line in mono, and `Open another team…`. It earns modality because there is no
canvas behind it to interact with. Never a blank canvas after a failed load.

---

## 10. First run and empty states

The first screen sets the whole tone, so it gets the most restraint.

### 10.1 No team file open

Full-bleed canvas, dot grid at its normal faint value, one centred composition, one action.
No sidebar, no chip, no mode pill — **nothing but the canvas and the invitation.** The
Library is hidden here, because there is nothing to drop onto yet.

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│                                                                   │
│                        ╱╲  ╱╲  ╱╲                                 │  woven mark
│                        ╲╱  ╲╱  ╲╱                                 │  40px, iris
│                                                                   │
│                          LoomWatch                                │  display/28
│                                                                   │
│              Compose a team of agents. Watch them work.           │  body, ink-2
│                                                                   │
│                    ┌────────────────────────┐                     │
│                    │      New team          │                     │  iris, 40px
│                    └────────────────────────┘                     │
│                                                                   │
│                  or open an existing team file                    │  ui/13, ink-2
│                                                                   │      link
│                                                                   │
│                                                                   │
│  3 harnesses ready                                        ⌘K      │  meta, ink-3,
└───────────────────────────────────────────────────────────────────┘  bottom corners
```

The bottom-left line is the only status: `3 harnesses ready`, or — the case that actually
matters — `No agent harnesses found`, clickable to the same search-path disclosure as
§4.3. Discovering at *first run* that nothing is installed is far better than discovering
it mid-drag.

The mark is a 3 × 2 chevron weave in `iris`, drawn as inline SVG. It is the only piece of
brand illustration in the product and it appears nowhere else at this size.

**No wizard, no tour, no sample-project gallery, no checklist.** One button.

### 10.2 Creating a team

`New team` does **not** open a modal. The headline is replaced in place by a single
borderless input, pre-focused, over `quick`:

```
                          ┌──────────────────────────┐
                    Name  │ Research and review      │
                          └──────────────────────────┘
                     research-team.yaml  in  ~/…/teams
                                                 ⏎ to create
```

The filename and destination render live beneath, in mono, derived by slugifying the name.
`Enter` creates. `Esc` returns to §10.1.

**The file is not written yet, and cannot be.** An empty team is schema-invalid by
construction: the root requires `entrypoint`, and `agents` has `minItems: 1`. A stub with
`agents: []` would be rejected by `PUT /api/team` with a `422`, and writing one anyway would
break the promise in §9.1 that LoomWatch never puts a file on disk the backend won't accept.

So `Enter` creates the **document**, not the file: the canvas opens with the chip in its
`new` state (§9.1) — `research-team.yaml · Not saved yet`, `Save` disabled with the hover
reason *"A team needs at least one agent."* The Library and mode pill fade in over
`entrance`, the §10.3 ghost node is centred, and the one obvious action is to drag an agent
onto it. Filling that agent's `role` and `model` (§4.5) enables `Save`, and ⌘S writes the
file — which is also the moment §9.4's reformat dialog does *not* fire, because there is no
prior content to reformat.

This costs one thing worth naming: for the first minute of a new team, the file-is-truth
model has no file behind it. The alternative — writing an invalid stub — costs more, because
it teaches that LoomWatch's own saves can produce files LoomWatch rejects. The `new` chip
state carries the honest version: this document is not on disk yet, and here is what it
needs before it can be.

The destination is the daemon's teams directory — a browser cannot choose a local path, so
this is server-side (§15.4); it is shown from the moment the name is typed so it is never a
mystery where the file will go.

### 10.3 Empty canvas, team file open

Library open, chip showing a clean file, mode pill on `Team · self-organizing`. Centred on
the canvas, a 264 × 88 **ghost node** — the exact silhouette of a real node, 1.5 px dashed
`hairline`, no fill:

```
        ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
                                       
        │   Drag an agent here         │
              from the left            
        └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

While a drag is in progress the ghost brightens to `iris`/40% and scales to 1.02. It
disappears permanently after the first successful drop in this document and never returns,
even if the last node is deleted — a hint that reappears is a nag.

### 10.4 One node, no edges

A `meta` line appears once, centred 32 px below the node, for 6 s:
*"Drag from the right edge of a node to sequence another after it."* Shown at most once per
browser, ever. That is the entire onboarding.

---

## 11. Keyboard and the command palette

There are no menus. ⌘K is the menu, and it is the reason the chrome can stay this thin.

**Palette** (`e2`, 560 px, centred, 22% from the top): a filter field and a flat, ranked,
**ungrouped** list — categories in a palette are Paperclip density in a smaller box. Each
row: icon, label, and its shortcut right-aligned in mono. Actions: `Add agent…` (expands to
the Library's rows inline), `Save`, `Open team…`, `New team…`, `Reload from disk`,
`Discard changes`, `Fit view`, `Auto-layout`, `Toggle library`, `Toggle minimap`,
`Toggle theme`, `Copy file path`, `Show YAML`.

`Show YAML` opens a read-only, syntax-highlighted sheet of exactly what would be written —
the escape hatch that makes the file-is-truth claim checkable at any moment, and the
progressive-disclosure answer to "why can't I see the YAML".

| Key | Action |
|---|---|
| `⌘K` | command palette |
| `⌘S` | save |
| `⌘Z` / `⇧⌘Z` | undo / redo (in-memory document; saving does not clear the stack) |
| `⌘\` | toggle Library |
| `Esc` | dismiss popover → deselect → close inspector, in that order |
| `Delete` / `Backspace` | delete selection (nodes take an inline confirm when they have edges) |
| `Enter` | rename the selected node · confirm an inline edit |
| `Tab` / `⇧Tab` | cycle nodes in `pipeline_order()`, else creation order; scrolls the node into view |
| `F` / `⇧F` / `⌘0` | fit · fit selection · reset zoom |
| `⌥⌘L` | auto-layout |
| `⌘+` / `⌘−` | zoom |

Every primary flow — create a team, add an agent, connect two agents, save — is reachable
without a pointer.

---

## 12. Accessibility

### 12.1 Baseline

- Contrast verified per §2.2 before the first build is accepted.
- Visible focus on every interactive element: 2 px `iris` at 2 px offset, plus the inner
  contrast ring on nodes (§5.2).
- The canvas is a labelled `application` region. Each node is a focusable element with an
  accessible name `"<name>, <role>, <model>, <status>"`; each edge, `"sequence from <a> to
  <b>"`. React Flow's `nodesFocusable` / `edgesFocusable` cover the traversal.
- Status, mode changes, save results and validation errors announce through a polite live
  region. Guard rejections and conflicts announce assertively.
- Hit targets ≥ 32 px; the edge hit area is 12 px wide regardless of stroke.
- Colour is never the only channel (Principle 5, §5.3, §6.1).

### 12.2 Reduced motion

Under `prefers-reduced-motion: reduce`:

- Observed edges **stop travelling** and render as static dashes in their kind's colour,
  with the count badge always visible. The layer distinction survives on colour + stroke +
  geometry (§6.1).
- The coincidence shuttle (§6.3) is replaced by an immediate tint + badge.
- The `running` breathe halo becomes a static 12 px halo at 0.25 alpha.
- Panel and inspector transitions become instant opacity changes.
- The mode-switch sequence (§8.3) plays as a single cross-fade with no rotation or stagger;
  the explanatory line still appears.
- Auto-layout applies instantly rather than tweening.

---

## 13. Window sizes

Designed for a resizable browser window, not a fixed app frame. PWA manifest requests
`display: standalone`, 1440 × 900.

| Width | Behaviour |
|---|---|
| ≥ 1280 | as specified |
| 1024 – 1280 | Inspector overlays the canvas edge instead of sitting beside it; Library unchanged |
| 768 – 1024 | Library collapses to the rail by default and expands as an overlay sheet with a scrim; Inspector likewise. Only one may be open at a time |
| < 768 | View-only: pan, zoom, tap a node for a read-only inspector sheet. Library, drawing and save are disabled, with a `meta` note in the chip: *"Editing needs a wider window."* |

Below 768 px the canvas is genuinely not editable with a thumb, and pretending otherwise
produces a worse result than saying so. Viewing a team from a phone on the LAN is still
useful, and Phase 05's watch surfaces are read-only anyway.

Height below 600 px: the mode pill and view controls merge into a single bottom-right
cluster.

---

## 14. Surfaces Phase 04 must reserve for Phase 05

Not specified here — they get their own document — but Phase 04 must leave room, or Phase
05 starts by moving things:

- **Timeline scrubber:** a 64 px dock along the bottom edge, full width minus 32 px, `e1`.
  When open, the mode pill and view controls translate up by 72 px. Phase 04 must place
  both with a bottom offset variable, not a constant.
- **Attention queue:** a 320 px `e1` panel below the document chip, top-centre, holding
  `escalate` calls and guard refusals — each an entry with the agent,
  the verbatim reason, and a `Show on canvas` action. It replaces the `MenuBarExtra` the
  native design would have used. Collapsed to a `copper` count badge on the document chip
  when empty of unread items.
- **Notifications:** Web Notifications, permission requested lazily at the **first**
  `escalate` — never on load. Title `<agent name> needs you`, body = `rawOutput.reason`
  verbatim, click focuses the tab and selects the node.
- **Run affordance:** the mode pill's right end reserves a 36 px slot for the run control.
  Phase 04 renders it disabled with the tooltip "Running a team arrives in a later phase."
  It is reserved so the pill's geometry does not change later.

---

## 15. Open decisions — operator / backend

Flagged rather than decided, per the design/backend boundary. Each blocks a specific part
of the build.

**What already exists** (TNG-52 + TNG-74, `crates/loomwatch-backend/src/api.rs`), so nobody
asks for it twice:

| Method | Route | Response |
|--------|-------|----------|
| `GET` | `/api/harnesses` | Detected harnesses only — `{id, name, command, executablePath, spawn:{cmd, args}}` |
| `GET` | `/api/teams` | Teams discovery — `{root, files}`; see representative response below |
| `GET` | `/api/team?path=` | `{path, yaml}` — confined to teams root |
| `PUT` | `/api/team` | Validates, `422` on invalid (server-side `TeamConfig::parse`), `atomic_write` (temp file + atomic rename) with no re-serialization — **unchanged by TNG-74** |
| `GET` | `/api/config/schema` | Embedded `team.schema.yaml` as JSON |

**Teams discovery representative response:**

```json
{
  "root": "/Users/me/.loomwatch/teams",
  "files": [
    "nested/a.YAML",
    "nested/b.yml",
    "z.yaml"
  ]
}
```

- `root` is the canonical absolute `LOOMWATCH_TEAMS_DIR` path (default `~/.loomwatch/teams`),
  `to_string_lossy()` encoded. Safe for display as-is or abbreviated (e.g. `~/…/teams`).
- `files` entries are lexicographically sorted, `/`-separated relative paths confined below
  `root`. The UI can safely form `{root}/{file}` with no path-traversal risk.
- Recursive directory scan: `.yaml` / `.yml` extension (case-insensitive), no directory
  symlink following, file symlinks accepted only when `fs::canonicalize` resolves inside root,
  paths with non-normal components silently excluded.
- Empty root returns `"files": []`.
- **Errors:** `GET /api/teams` is read-only; the only discovery-specific failure is an internal
  scan error, which returns `500` with a `failed to discover team files` message. (Standard HTTP
  statuses — `403` for unallowed hosts, `405` for unsupported methods — also apply.) It never
  fails for a missing root — the daemon canonicalizes `LOOMWATCH_TEAMS_DIR` at startup and
  refuses to boot if it cannot, so an unreachable root is a startup error, not a per-request one.

The gaps below are what Phase 04 still needs *beyond* that.

1. ~~**Node layout persistence (§7.3).**~~ **Decided 2026-09-13** — option A, the existing
   `<team>.layout.json` sidecar (ADR 0016). The original wording follows: Sidecar
   `<team>.layout.json` (recommended), an
   `Agent.ui` schema addition, or `localStorage`. Needs a schema/backend call. *Blocks:*
   position persistence only — deterministic auto-layout ships regardless.
2. **Configured edge `kind` (§6.6).** The schema pins configured edges to `sequence`; the
   Phase 04 brief asked for a `sequence | dispatch | ask | handoff` selector on configured
   edges. **Following the schema.** Opening it up is a schema change + ADR, and would also
   change what pipeline mode means. *Blocks:* nothing today; the UI is designed to accept
   it later.
3. **Library data source — two of three groups have no backend at all.**
   - *Harnesses (partly solved).* `GET /api/harnesses` covers the detected group. Two
     additions would remove client-side guessing: (a) return the **not-installed** harnesses
     too, with an `available: false` flag, so §4.2's list stops being a client-side constant
     that can drift from the daemon's `HARNESSES` table; (b) return the **search `PATH`**
     the daemon used, so §4.3's failure state can show it. Both are additive fields on an
     endpoint nothing else consumes yet. *Blocks:* §4.2 fidelity and §4.3's disclosure —
     not the group itself.
   - *Advertised models.* Nothing reports which models a harness can reach, which is why
     §4.5 leaves `model` empty. A `models: string[]` on `DetectedHarness` would turn the
     inspector's combobox from free-text-only into free-text-with-suggestions. **Note this
     may not be knowable** — for `opencode` the answer is "whatever it is configured for".
     Free text must stay the fallback. *Blocks:* nothing; it is a quality-of-life ask.
   - *Endpoints and presets (unsolved).* Needs `GET|POST /api/endpoints` and
     `GET|POST /api/presets`, plus a decision on **where they persist** — neither is in
     `team.schema.yaml`, and neither belongs to any one team file. Proposal:
     `~/.loomwatch/library.yaml`, its own small schema, its own ADR. *Blocks:* two of the
     three Library groups; Phase 04 builds them against fixtures and ships them empty.
4. **Teams directory: change notification and the `Open team…` workflow (§9.3, §10.2).**
   `GET /api/teams` (TNG-74) and create-on-save via the existing `PUT /api/team` — a missing
   file with an existing parent beneath the teams root is created by `atomic_write` — cover
   listing and §10.2's create. What remains genuinely missing: a **change notification**
   channel and a picker for the UI to resolve a listed relative `{root}/{file}` into an
   absolute `?path=` (which `GET /api/team` still requires). Also worth deciding: the daemon
   currently isolates all team-file access to `LOOMWATCH_TEAMS_DIR` and rejects paths that
   resolve outside it (TNG-59), which closes the LAN security concern noted earlier.
   - **Conflict detection needs a revision token.** `{path, yaml}` carries no `mtime` or
     `etag`, so §9.3 currently hashes the YAML client-side. An `etag` on `GET` plus
     `If-Match` on `PUT` would make it correct and would close the lost-update window
     between two open tabs.
   - **The push channel touches the frozen WebSocket schema** — a message that is not a
     `RunEvent` cannot go down the existing socket without an ADR (WEBSOCKET_SCHEMA.md §1).
     Proposal: a separate `/api/config/events` SSE stream, leaving the frozen socket
     untouched. **Escalating this one** — it is exactly the frozen-schema conflict my
     instructions say to raise rather than decide.
   - *Blocks:* `Open team…` reaching files by picker instead of typed path; §9.3 degrades to
     focus-polling without it.
5. ~~**YAML comment preservation on save (§9.4).**~~ **Resolved, no decision needed.**
   `TeamFileModel` is CST-preserving and `PUT /api/team` writes verbatim bytes, so comments
   and key order survive. The reformat modal is withdrawn (§9.4). The standing ask is a
   **regression test** — load → save with no edits is byte-identical — so this stays true by
   construction rather than by luck. *Blocks:* nothing.
6. **Reveal in Finder (§9.1).** A browser cannot. Either the daemon exposes an
   `open-in-file-manager` endpoint (a local-only privilege it already has) or the
   affordance stays as copy-path. Recommendation: copy-path for v1. *Blocks:* nothing.
7. **React Flow attribution.** xyflow is MIT and requires the "React Flow" watermark in the
   bottom-right unless a Pro licence is held. It collides with the view controls. Either
   keep it (and this spec moves the view controls left by 96 px) or licence Pro. This is a
   money/licensing call. *Blocks:* the bottom-right layout.

---

## 16. Phase 04 build checklist

The spec's acceptance surface, in build order:

1. Tokens: the §2 CSS custom properties, Tailwind theme extension, light/dark, self-hosted
   fonts, `prefers-reduced-motion` media query wired to the §12.2 fallbacks.
2. Shell: canvas + the five floating elements (§3), collapse/expand, responsive rules
   (§13), command palette (§11).
3. `agentNode` custom node: anatomy, eight status treatments, three levels of detail,
   selection states (§5).
4. Library: three groups, drag-to-instantiate, not-installed disclosure, empty states
   (§4) — the detected group against `GET /api/harnesses`, endpoints and presets against
   fixtures until §15.3 lands.
5. Inspector: fields, live validation against the schema and TEAM_CONFIG.md rules,
   collapsed spawn section, credential warning (§5.4).
6. Edges: `configuredEdge` and `observedEdge` custom edge types, the §6.2 visual table, the
   coincidence rule, drawing/refusal/deletion (§6.6) — the observed layer built against
   **fixture events in the WEBSOCKET_SCHEMA shape**, so Phase 05 only connects the socket.
7. Canvas mechanics: pan/zoom, snapping, guides, auto-layout, deterministic seeded layout
   when no positions exist (§7).
8. Mode framing: the pill, both canvas states, the switch sequence, the last-edge
   confirmation (§8).
9. Round-trip: the document chip's seven states, explicit save against `PUT /api/team`,
   validation gate driven by `GET /api/config/schema`, external-change handling, read-only
   version handling, the parse-failure modal (§9).
10. First run (§10).

**Definition of done for the visual language:** a screenshot of a populated canvas in dark
mode and one in light mode, side by side, in which (a) configured and observed edges are
distinguishable in greyscale, (b) no panel occupies more than 288 px, and (c) exactly one
element on screen is `iris`-filled.
