---
version: alpha
name: LoomWatch — Obsidian & Gilt
description: >-
  A local-first workspace for composing teams of AI agents, watching them work, and reviewing
  what they produced. Black stone and gold thread: structure is graphite, the operator's action
  is gold, live execution is blue. Dark is the default theme; light ("quarry") is the same
  system at a lower value.
colors:
  # Dark theme ("obsidian"), the default. Light values are under light-theme below.
  ground: "#08080A"
  ground-dot: "#1E1E23"
  panel: "#101013"
  panel-solid: "#131316"
  ink: "#F5F3EE"
  ink-2: "#A9A59C"
  ink-3: "#85817A"
  warp: "#666259"
  primary: "#E9C46A"          # = accent: lines, rings, text, glyphs, the observed weft
  accent: "#E9C46A"
  accent-fill: "#D8A93C"      # the one filled primary action per screen
  accent-on-fill: "#08080A"
  accent-dim: "#8C7130"
  accent-tint: "#1A1508"
  live: "#6AB8FF"
  live-dim: "#2F7DD3"
  live-tint: "#0A2038"
  alert: "#F2635C"
  ok: "#4FC98D"
  halt: "#8C8C98"
  hairline: "rgb(255 255 255 / 0.09)"
light-theme:
  colors:
    ground: "#FAF8F3"
    ground-dot: "#DFD9CD"
    panel: "#FFFFFF"
    panel-solid: "#FFFFFF"
    ink: "#17150F"
    ink-2: "#56524A"
    ink-3: "#6E6862"
    warp: "#8B857C"
    accent: "#8A6A16"
    accent-fill: "#AD8A20"
    accent-on-fill: "#17150F"
    accent-dim: "#9C8440"
    accent-tint: "#F5F0E4"
    live: "#175CD3"
    live-dim: "#2F7DD3"
    live-tint: "#EAF2FF"
    alert: "#C0342E"
    ok: "#17724A"
    halt: "#605F6B"
    hairline: "rgb(23 21 15 / 0.10)"
typography:
  display:
    fontFamily: Instrument Serif
    fontSize: 34px
    fontWeight: 400
    lineHeight: 38px
    letterSpacing: "-0.01em"
  title:
    fontFamily: Inter
    fontSize: 19px
    fontWeight: 600
    lineHeight: 26px
    letterSpacing: "-0.01em"
  body:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  body-m:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
  node:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: 550
    lineHeight: 20px
    letterSpacing: "-0.01em"
  ui:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 500
    lineHeight: 18px
  meta:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  micro:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: 600
    lineHeight: 14px
    letterSpacing: "0.07em"
  mono:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 17px
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: 400
    lineHeight: 15px
  story:
    fontFamily: Instrument Serif
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.45
rounded:
  xs: 4px
  sm: 8px
  md: 10px
  lg: 14px
  full: 999px
spacing:
  sp-1: 4px
  sp-2: 8px
  sp-3: 12px
  sp-4: 16px
  sp-5: 20px
  sp-6: 24px
  sp-7: 32px
  sp-8: 48px
components:
  button-primary:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.accent-on-fill}"
    typography: "{typography.ui}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0 12px
  button-primary-large:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.accent-on-fill}"
    rounded: "{rounded.md}"
    height: 44px
    padding: 0 32px
  button:
    backgroundColor: transparent
    textColor: "{colors.ink-2}"
    typography: "{typography.ui}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0 12px
  button-hover:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.ink}"
  icon-button:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    size: 32px
  input:
    backgroundColor: "{colors.panel-solid}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 0 12px
  agent-card:
    backgroundColor: "{colors.panel-solid}"
    textColor: "{colors.ink}"
    rounded: 7px
    width: 220px
    padding: 12px 13px
  agent-node-spec:
    backgroundColor: "{colors.panel-solid}"
    textColor: "{colors.ink}"
    typography: "{typography.node}"
    rounded: "{rounded.lg}"
    width: 276px
    height: 96px
  library-row:
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: 44px
    padding: 8px 12px
  composer:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    width: 720px
    height: 56px
  home-card:
    backgroundColor: "{colors.panel-solid}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: 108px
    padding: 16px 32px 16px 16px
  story-name-chip:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    height: 22px
    padding: 0 9px
  badge-live:
    textColor: "{colors.live}"
    rounded: "{rounded.full}"
    padding: 1px 8px
---

# LoomWatch design system — "Obsidian & Gilt"

This file is the brief for designing LoomWatch screens outside the codebase (Claude Design,
mockups, decks). It condenses [`docs/DESIGN_LANGUAGE.md`](../DESIGN_LANGUAGE.md) (the
board-approved spec, rev. 3) and ADRs 0022–0026, checked against what `ui/` actually ships on
2026-10-01. Where the spec and the shipped UI disagree, this file says so under
**Open conflicts** rather than picking silently.

Load order for a mockup: `fonts/fonts.css` → `tokens.css` → `components.css`, then put
`data-theme="dark"` or `data-theme="light"` on `<html>`.

## Overview

**What the product is.** LoomWatch is a local app (a Rust daemon serving a web UI) where a person
composes a *team* of AI agents — each running on an AI app already installed on their computer
(Claude, Codex, Gemini, OpenCode, Hermes…) — gives the team a task in plain words, watches each
step as it happens, and reviews the result before using it. Three screens carry almost
everything:

- **Home** — "Put AI agents to work as a team." A serif headline, one gold *New team* button,
  three numbered steps (Build · Ask · Review), and the operator's teams as cards, each with its
  recent runs drawn as woven threads.
- **Build** — a canvas. The team as one plain sentence across the top ("Every day at 10:00 AM
  and whenever you ask, News Collector collects what is needed, then News Editor edits…"), a
  *Hire by job* palette on the left (Researcher, Writer, Editor, Reviewer, Coder, Designer,
  Analyst, You), cards wired left-to-right, a Story · Team · Trace depth dial bottom-right.
- **Run** — result-led. Left: the request, the team handoff as numbered stage cards, a run
  receipt, a timeline. Right: the team's output in a reader, with a composer for follow-ups.

**Thesis — the loom.** The configured team is the **warp**: static, structural, drawn in
neutral graphite. Observed activity is the **weft**: gold thread travelling along the warp.
Ground is stone — near-black in dark, warm quarried paper in light. **Gold** is scarce and means
*you / act here / selected / identity*. **Blue** means only *executing now*. Everything else is
stone, graphite and three semantic signals (red wrong, green finished well, slate deliberately
stopped). The loom is not decoration: it is literally how the product draws configured versus
observed edges, so the premium look and the architecture are one decision.

**Audience — one surface, three depths.** The same screen serves someone who has never heard
of an "entrypoint" and an expert who wants ids, models and the raw event record. There is no
Simple/Pro mode. Every surface reads as a plain **story** first, lets you lean in to the
**team**, and again to the **trace**. Plain name first, real name one hover away; defaults for
newcomers, keys for experts; every plain sentence links to its evidence; fold, never hide.

**Personality.** A considered instrument, not a dashboard. Calm, dark, precise, a little
literary (the serif voice), never playful, never cute, never "AI sparkle". Minimal density —
explicitly *not* a dense ops console.

## Colors

Three tiers, and only the middle one flips between themes:

1. **Primitives** (`--lw-obsidian-950`, `--lw-gold-200`…) — raw ramps. Never used by a component.
2. **Semantic** (`--color-ground`, `--color-ink`, `--color-accent`…) — role names; the only tier
   that changes with the theme. Components use these.
3. **Component aliases** (`--lw-node-fill`, `--lw-edge-warp`…) — greppable names for tier 2.

**The one rule:** a design may reference tier 2 or tier 3 only. A raw hex in a component is a
bug that shows up in one theme only.

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `ground` | `#08080A` | `#FAF8F3` | canvas and page ground |
| `ground-dot` | `#1E1E23` | `#DFD9CD` | 16 px dot grid — texture only, the one sub-3:1 value |
| `panel` | `#101013` | `#FFFFFF` | floating glass panels (used at ~66% + blur) |
| `panel-solid` | `#131316` | `#FFFFFF` | cards, popovers, inputs |
| `hairline` | white 9% | ink 10% | every 1 px border and divider |
| `ink` / `ink-2` / `ink-3` | `#F5F3EE` / `#A9A59C` / `#85817A` | `#17150F` / `#56524A` / `#6E6862` | primary / secondary / tertiary text |
| `warp` | `#666259` | `#8B857C` | configured edges, dormant handles |
| `accent` | `#E9C46A` | `#8A6A16` | gold as a line, ring, glyph or text |
| `accent-fill` | `#D8A93C` | `#AD8A20` | the one filled primary action |
| `accent-on-fill` | `#08080A` | `#17150F` | label on `accent-fill` |
| `accent-dim` | `#8C7130` | `#9C8440` | aged weft, hover borders |
| `accent-tint` | `#1A1508` | `#F5F0E4` | selected/hover backgrounds, name chips |
| `live` / `live-dim` / `live-tint` | `#6AB8FF` / `#2F7DD3` / `#0A2038` | `#175CD3` / `#2F7DD3` / `#EAF2FF` | executing now |
| `alert` | `#F2635C` | `#C0342E` | wrong: failed, invalid, destructive, anomaly |
| `ok` | `#4FC98D` | `#17724A` | finished well, saved |
| `halt` | `#8C8C98` | `#605F6B` | deliberately stopped, read-only, waiting |

All text tokens clear WCAG AA against `ground` and `panel-solid` in both themes (ratios in
DESIGN_LANGUAGE §4). **Gold in light mode is bronze, on purpose**: `#8A6A16` is the brightest
gold that passes text contrast on ivory. Never brighten light-mode gold to match dark.

**What each colour means — law, not guidance.**

| Meaning | Token | Where it appears |
|---|---|---|
| Act here / selected / you | `accent`, `accent-fill` | selection ring, focus ring, the primary button, start-agent ring, observed weft, unfinished field, step numbers, the review step ("You") |
| Executing now | `live` | running agent perimeter and glyph, streaming result, the live thread |
| Wrong | `alert` | failed, invalid, destructive confirm, anomaly, refusal, parse failure |
| Finished well | `ok` | succeeded, "Saved" |
| Deliberately not running | `halt` | stopped, waiting/queued, read-only |
| Structure | `warp` | configured edges, dormant handles, ghost outlines |
| Everything else | `ink` ×3 | all text and glyphs, idle, unavailable, app monograms |

**Four laws.**

1. **Gold is semantic, never decorative.** Nothing is gold because it "needs colour".
2. **One gold fill per screen; gold as a line is unlimited.** `accent-fill` (solid gold plane,
   dark label) appears at most once — the current primary action. All other gold is stroke,
   ring, dash, glyph, 1 px border or tint. Checkable from a screenshot.
3. **Never signal with colour alone.** Every status and edge kind differs on at least two of
   {colour, shape, stroke pattern, motion, a visible word}.
4. **Red never decorates and never counts.** A red badge showing "3 agents" is forbidden.

Further rules: text on `accent-tint` is always `ink` (never `accent`); light `accent-fill` is
only legal as a filled control ≥ 32 px with an `accent-on-fill` label; no vendor colour, ever;
blue is not a second brand accent and never fills a button.

## Typography

Three self-hosted families (in `fonts/`, no CDN): **Inter** (variable) for all UI,
**JetBrains Mono** for anything the operator could type into the team file, **Instrument
Serif** (400 only) for the product's *story voice*.

| Step | Size / line | Weight · tracking | Family | Used for |
|---|---|---|---|---|
| `display` | 34 / 38 (Home hero 32–46 fluid) | 400 · −0.01em | serif | headlines: Home hero, "Your team is ready", "What should the team do?" |
| `title` | 19 / 26 | 600 · −0.01em | sans | panel and dialog titles, "Team response" |
| `body` / `body-m` | 14 / 20 | 400 / 500 | sans | fields, rows, prose |
| `node` | 15 / 20 | 550 · −0.01em | sans | an agent's name where it must read at a glance |
| `ui` | 13 / 18 | 500 | sans | buttons, chips, menu items |
| `meta` | 12 / 16 | 400 | sans | captions, help text, role lines |
| `micro` | 11 / 14 | 600 · +0.07em · UPPERCASE | sans | eyebrows, group headers, badges ("YOUR TEAMS", "TEAM OUTPUT") |
| `mono` / `mono-sm` | 12 / 17, 11 / 15 | 400 | mono | ids, models, paths, file names, YAML |
| `story` | 17–22 / 1.35–1.45 | 400 | serif | the team sentence, timeline narration, review context, output headings |

- **The serif is a voice, not a style.** It carries what the product *says to you* in plain
  language: headlines, the team sentence, the timeline's "read it as a story", a run's output
  headings (h1 42 px, h2 28 px). It never labels a control.
- **Mono is semantic.** Model strings, agent ids, paths, file names, durations, keyboard keys.
  Prose is never mono.
- **Tabular numerals** on every count, duration, step number and time.
- **Nothing below 10 px.** 7–9 px labels were removed in ADR 0022.

## Layout

- **Spacing:** 4 px base, eight steps only — `4 8 12 16 20 24 32 48`.
- **Panels:** inset 20 px from the viewport; panel padding 20 px; section gap 20 px; rows 40–44
  px with 6 px between them.
- **Widths:** library/palette 288 px (shipped Build palette 210 px), inspector 320 px, schedule
  panel 360 px, composer 720 px, palette/popovers 560 px max, Home column 1040 px, settings
  column 640 px.
- **The canvas is the product:** no panel wider than 320 px; canvas ≥ 70% of the viewport.
- **Run is result-led:** the output reader takes roughly a third to a half of the width on the
  right; the work trail (request → handoff stages → receipt → timeline) reads top-down on the
  left.
- **Breakpoints:** ≤ 767 px phone (canvas becomes a reading column; panels become bottom sheets;
  every control ≥ 44 px), 768–1179 tablet, ≥ 1180 desktop.
- **Background:** the canvas and Home sit on a faint 16 px dot grid (`ground-dot`, 1 px dots).

## Elevation & Depth

Two levels; nothing stacks three deep.

| Level | Used for | Treatment |
|---|---|---|
| `e1` glass | floating panels, chip, inspector, view controls, composer | `panel` @ 66% + `blur(24px) saturate(150%)`, 1 px `hairline`, a faint 135° white sheen; **dark** adds a 1 px top-inset rim light and `0 8px 32px rgb(0 0 0/.55)`; **light** uses `0 1px 2px /.04, 0 8px 24px /.08` |
| `e2` opaque | popovers, ⌘K palette, the one dialog | `panel-solid`, **opaque in both themes** (never blur text someone must read carefully), 1 px `hairline`, deeper shadow |

**Bloom** (a 6 px gold/blue drop-shadow glow at 22%) exists only in dark mode, only on the live
weft and the running halo, and disappears under reduced motion. No glow on paper.

## Shapes

- **Radius:** `xs` 4 (badges, kbd) · `sm` 8 (inputs, buttons) · `md` 10 (rows, cards) · `lg` 14
  (floating panels, spec nodes, Home cards) · `full` (pills, dots). The shipped workspace layer is
  tighter: canvas cards 7 px, header buttons and tabs 5 px, view switch 7 px.
- **Stroke:** hairlines are exactly 1 px. Three exceptions: selection ring 2 px, status rail
  3 px, handoff weft 2.5 px.
- **No gradients** beyond the 6% panel sheen. No metallic gold. No illustration. Icons are
  `lucide` at 16 px / stroke 1.5 in panels, 18 px on nodes.

## Components

Rendered references for every item below are in `preview/`; class names match `components.css`
and the app.

**Buttons.** `.btn` 28 px, transparent with a hairline border, `ink-2` → hover `accent-tint` +
`ink`. `.btn-primary` is the gold fill (rationed by Law 2). `.btn-lg` 44 px for Home/empty
states; `.btn-head` 42 px for workspace header actions (*Run team*, *Review output*,
*Edit team*). `.btn-danger` turns red on hover; `.btn-danger-fill` exists only inside an inline
confirm. `.link` is gold text. `.iconbtn` 32 px; pressed = gold glyph. Touch: all become 44 px.

**Switches.** Run | Build view switch (header centre); Story · Team · Trace depth dial (tint +
gold text, never a fill); underline tabs (gold 2 px underline).

**Fields.** 32 px inputs on `panel-solid`. Focus = gold border. **Unfinished is gold, wrong is
red:** a required field never filled gets a gold border and a gold hint ("Required"); an invalid
value gets a red border and a red message. Both block save. A fresh item is never greeted with
red. Checkboxes fill with `accent-fill` when on.

**Status — shape first, colour second, word third.**

| Status | Shape | Colour | Word / motion |
|---|---|---|---|
| idle | hollow ring | `ink-3` | — |
| starting | ring + rotating 90° arc | `live` | STARTING |
| running | filled dot; card perimeter breathes (2.4 s) | `live` | RUNNING / STREAMING |
| waiting | hollow diamond | `halt` | QUEUED — no motion, it is not progressing |
| succeeded | filled circle + check | `ok` | DONE |
| failed | filled circle + × | `alert` | ERROR |
| stopped | filled square, dashed perimeter | `halt` | CANCELLED |
| unavailable | dashed ring | `ink-3` @ 40% | OFFLINE |

**Agent card (canvas).** Shipped Build/Run card: 220 × 76 (248 × 88 with a run), 7 px radius,
`panel-solid`, 34 px icon tile holding the agent's mark, an uppercase `node-kind` eyebrow, a 12 px
550 name, an 11 px `ink-2` line ("Collects what is needed"), a gold `START` tag on the first
agent, a 16 px step badge outside the top-left corner. With a run it adds a task row (`RUNNING`
+ what it is doing) and mono meta (app · model). Perimeter = run status (blue running, green
done, red failed); selection = gold ring. The spec'd larger node (276 × 96, 14 px radius, 3 px
status rail, 15 px `node` name, 18 px role glyph) is the same anatomy at canvas reading size.
*Capability cards* (skills, tools, sources) are dashed: editable intent, never a claim it ran.
The *review step* (the operator) is a card with a gold perimeter and a question.

**Edges — warp and weft.**

| Kind | Stroke | Colour | Marker | Motion |
|---|---|---|---|---|
| configured (sequence) | 1.5 px solid | `warp` | filled arrow | none |
| observed dispatch | 1.5 px dash 6 4 | `accent` | open arrow | dashes travel (1.4 s) |
| observed ask | 1.5 px dash 2 3, 80% | `accent` | arrows both ends | travels back and forth |
| observed handoff | 2.5 px dash 10 4 | `accent` | double chevron | travels once, then static |
| anomaly | 1.5 px dot 1 4 | `alert` | open arrow + ⚠ badge | travels |

Structure is a quiet grey solid line; activity is a travelling gold dashed line beside it. The
two layers must stay distinguishable in greyscale. Lines attach at fixed ports (left in, right
out, 44 px from the card top), route with the fewest card crossings, and carry short labels
("hands off" only where it adds meaning, "responds with" on the output arc).

**Library / Hire-by-job rows.** 44 px cards, hairline border, `panel-solid` @ 38%, grab cursor,
trailing grip dots. Name in `ink`, one-line job in `ink-2`, the app in gold mono ("on Claude").
Hover/armed = `accent-tint` + gold border (armed adds a 3 px gold inset rule).

**Inspector.** 320 px e1 panel, 20 px padding, three zones (Identity · Behaviour · Process)
headed by `micro` labels with a hairline running to the edge. Facts as a two-column `dt/dd`
list with `ink-3` keys and `ink-2` values.

**Composer.** 720 × 56 e1 bar at the bottom centre of the workspace. A mode chip on the left
(gold glyph), a growing textarea ("What should the team do?", up to 5 lines), actions on the
right with `kbd` hints. ↵ sends, ⇧↵ adds a line. A note line under the text turns gold for an
unfinished requirement and red for an error.

**Popovers & ⌘K.** e2 opaque, 560 px. Search row, then 34 px rows (hover/active = tint).
⌘K speaks two dialects: plain words ("add a reviewer", "looks good") and `/commands`; an
understood phrase shows as one proposed action in a tinted, gold-bordered row before it runs.

**Bars & notices.** Full-width 40 px transport bars on `panel-solid` mark their status with a
3 px inset rule on the left (`halt` read-only, `alert` conflict, `ok` saved) — never a coloured
fill. Notices are small hairline pills; inline errors are dashed red boxes.

**Home card.** `panel-solid`, 14 px radius, 600 16 px name, "3 steps · edited 2 hours ago",
the **run fabric** (one short vertical thread per recent run: gold finished, red failed, blue
working, dashed gold ring waiting on you), and the file name in mono. Hover lifts 1 px and the
arrow turns gold. A team waiting on you gets a gold-tinted "Needs you" pill.

**Team sentence.** The team as prose in the serif story voice, agents as pill chips
(`accent-tint` with a gold-35% border, sans 600 13 px, the agent's mark inside), the schedule as
a gold outline chip, "You" as a dashed chip, and one-click repairs as small gold outline buttons
("Put Writer after Researcher").

**Agent mark.** Every agent wears a 3 × 3 woven swatch derived from its id: at each crossing
either a gold horizontal float (weft on top) or a grey vertical one (warp on top). Same agent,
same swatch, everywhere. It moves only from recorded state: rows pulse blue while thinking, a
blue shuttle runs while it uses a tool, a knot ties off when done, the centre breaks red when it
fails, a gold halo pulses when it waits on you. The operator wears a dashed gold ring instead.
**No faces, no avatars, no vendor logos** (ADR 0025).

**Run receipt & timeline.** The receipt is a slightly rotated paper slip in mono ("RUN RECEIPT ·
Run 21 · Finished", asked / team / took / ran on, then who did what, what failed and what happened
instead, "Worth a look"), with *Copy as Markdown* and *See every event*. The weft timeline has
one lane per agent: a graphite warp line, a gold thread where it worked (blue while live, red
where it failed, a dashed gold outline for time spent waiting on you), stitches for recorded
calls and a gold playhead; dragging narrates each moment in a serif sentence.

**Files the team produced.** A file named in a reply becomes a card ("Word document · 48 KB ·
changed 2 min ago · Daily news › Writer") with Open · Show in folder · Copy path, and an inline
chip in the sentence. Never a raw path, never a `file://` link.

## Motion

| Name | Duration | Easing | For |
|---|---|---|---|
| instant | 90 ms | `cubic-bezier(.2,0,0,1)` | hover, press, focus |
| quick | 160 ms | same | popovers, panel collapse, tooltips |
| move | 240 ms | same | mode change, node settle, layout |
| entrance | 320 ms | same | first-run composition, theme switch (a single gold sweep) |
| flow | 1400 ms | linear, infinite | travelling weft dashes |
| breathe | 2400 ms | ease-in-out | running perimeter / live pips |
| settle | 900 ms | `cubic-bezier(.2,0,0,1)` | the save "ledger" line under the document chip |

Exits use `cubic-bezier(.4,0,1,1)` at 0.75×. Never animate position, opacity and scale at once.
Nothing on the canvas animates while the user pans or zooms. Under reduced motion: no
travelling dashes, no bloom, no sweep; running becomes a static 2 px blue perimeter; every
state stays legible through shape and words.

## Voice & content

- **Plain words on screen, spec words in the file.** "AI app", not "harness"; "starting agent",
  not "entrypoint"; "Writer", not "Agent C · responder"; "Claude", "You (review step)",
  "Custom command: python3".
- **Say what happened and what to do next.** "News Collector couldn't open usnews.com", then the
  repair. Validation names the place and the rule, never raw schema output.
- **Easy answers are easy.** "Looks good" approves without a comment; "Send back to Researcher"
  uses the agent's name.
- **Sentence case** for buttons and headings; `micro` uppercase only for eyebrows and status
  words. Verbs on buttons: *New team*, *Run team*, *Review output*, *Copy as Markdown*.
- **Empty states invite, they don't apologise:** "No runs yet — the first one starts the cloth."
- **Keys are for experts, never required:** every action is clickable; key hints are hidden on
  touch screens.

## Do's and Don'ts

**Do**
- Start dark (`#08080A` ground, bone ink, gold accents); show light as the same layout.
- Use exactly one gold-filled button per screen, for the action the user is on.
- Draw configured structure in graphite and live activity in blue/gold motion beside it.
- Give every status a shape and a word, not just a colour.
- Lead Run screens with the result; keep the process one click away.
- Use the serif only for things the product *says*; mono only for things the user could *type*.

**Don't**
- Don't add a second accent colour, gradients, metallic gold, glow in light mode, or vendor
  colours/logos for AI apps (they are monochrome monograms: `C`, `Cx`, `G`, `Oc`).
- Don't use blue for anything but executing now; don't use red for counts or decoration.
- Don't give agents faces, avatars or mascots.
- Don't blur text that must be read carefully (popovers, dialogs, the output reader).
- Don't put spec vocabulary (harness, entrypoint, packet, ACP) in user-facing copy.
- Don't use labels under 10 px or panels wider than 320 px over the canvas.

## Open conflicts (spec vs shipped, 2026-10-01)

These are real differences between `DESIGN_LANGUAGE.md` and `ui/`. A design should follow the
**shipped** column unless the owner decides otherwise.

| Topic | Spec says | Shipped |
|---|---|---|
| Run/Build switch | gold as a line or tint only (Law 2) | pressed segment is a solid `accent` plane, so Build and Run screens show two gold fills next to *Run team* / *Review output* (`prototype-workspace.css` overrides the tint rule in `delivery.css`) |
| Serif scope | wordmark and first-run headline only | the product's story voice: headlines, team sentence, timeline narration, output headings |
| Canvas card | 276 × 96, 14 px radius, 15 px name | 220 × 76, 7 px radius, 12 px name (result-led workspace prototype, 2026-09-14) |
| e1 glass | panel @ 72–76%, blur 20 px | panel @ 66%, blur 24 px + saturate 150% + sheen |
| Theme switch | `.dark` class, key `loomwatch.theme`, default "system" | `data-theme` on `<html>`, key `loomwatch:theme`, default dark |
| Run fabric | `ok` (green) means finished | finished threads are gold `accent-fill`; green is not used there |
| Hex literals | none outside tokens.css | a few remain in `prototype-*.css` and `loom.css` (shadows such as `#0003`) |
