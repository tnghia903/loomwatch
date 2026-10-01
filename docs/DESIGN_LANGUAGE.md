# LoomWatch — Design language "Obsidian & Gilt"

Revision 3 · 2026-09-10 · **approved by the board 2026-09-10 (TNG-87); implemented in `ui/` 2026-09-11 — see [ADR 0009](decisions/0009-prompt-to-output-workspace-shipped.md)**

This document replaces [CANVAS_SPEC.md](CANVAS_SPEC.md) **§2 (Visual language)** in full. It
does not change CANVAS_SPEC's interaction contracts; those are amended separately in
[UX_REDESIGN.md](UX_REDESIGN.md). Everything else in CANVAS_SPEC.md — principles (§1),
layout skeleton (§3), the two-edge-layer requirement (§6), YAML round-trip (§9),
accessibility baseline (§12) — stands, and this revision is written to satisfy it, not to
escape it.

**Governing documents.** [ARCHITECTURE.md](ARCHITECTURE.md) §5 (canvas is a visual editor
over version-controlled YAML; two edge layers must be distinguishable at a glance) and §6
(web UI, eye-catching and minimal, explicitly not Paperclip's density).
[ADR 0003](decisions/0003-web-ui-served-by-the-daemon.md).

**Board direction driving this revision (TNG-87).** Add a dark mode toggle; the dark theme
must be black + gold; re-tune light so the two themes are one system; drive both from a
shared token layer.

**Buildability.** Every value here is a CSS custom property consumed through Tailwind v4's
`@theme` directive (`ui/src/index.css`), which is what the `ui/` scaffold already ships. No
new runtime dependency, no CDN, no external asset request — LoomWatch is local-first and
must render with no internet (CANVAS_SPEC §0).

---

## 1. Why v1 needed re-tuning, beyond the board's brief

Revision 1's palette was defensible: warm-neutral ground, one cool accent (`iris`), one
attention accent (`copper`). Three things were wrong with it in practice, and the black+gold
direction is an opportunity to fix all three rather than just recolour.

1. **`iris` was doing two unrelated jobs.** "This is selected / this is the primary action"
   and "this is live activity" were the same violet. On a running canvas the operator could
   not tell a selected node from a busy one without reading shape. v2 splits the jobs by
   **fill versus line** (§8, Law 2) instead of by hue, which costs no palette budget.
2. **`copper` and `iris` were not far enough apart under motion.** A travelling dashed
   violet edge and a static copper anomaly badge read as one family at 60% zoom. v2 puts the
   attention signal in the **red** family, a full 40° of hue away from gold, and gives
   "unfinished" to gold — which is more honest, because unfinished means *act here*, which
   is exactly what gold means everywhere else in the product.
3. **Dark mode was light mode with inverted lightness.** Same shadow model, same border
   opacity, same accent lightness. Real dark UI needs a different elevation model (light
   rims, not drop shadows) and a different accent lightness, or the panels dissolve into the
   ground. v2 specifies elevation twice (§10).

Revision 3 adds one operational signal the board asked to distinguish explicitly: **blue
means live execution**. Gold no longer carries runtime state; it remains the scarce material
for selection, focus, entry points, the observed weft, and the primary action.

---

## 2. Thesis — the loom, in two materials

The motif was already the right one and is kept: the configured graph is the **warp**
(static, drawn, structural), observed activity is the **weft** (moving, bright, transient,
travelling along the warp where it agrees with it). Revision 1 named it; revision 2 makes it
the whole palette.

> **Obsidian and gilt.** The ground is stone — near-black in dark, warm quarried paper in
> light. Structure is cut into the stone in neutral graphite. **Gold** is scarce and marks
> operator action, selection, and the product's observed weft. **Blue** is operational and
> means only *executing now*. Everything else is stone, graphite, and semantic signals.

This is why the board's brief and the architecture agree instead of fighting: a gold thread
travelling along a graphite line on a black ground **is** the observed layer over the
configured layer (ARCHITECTURE §5). The premium look and the named architecture requirement
are the same design decision.

Consequences, stated so nobody has to infer them:

- **No gradients** beyond one 6% surface sheen on panels. No metallic gradient on gold — a
  gradient would make it decorative, and gold is semantic here.
- **No glow in light mode.** Bloom is a dark-mode-only affordance (§10).
- **No vendor colour, ever.** Harness marks stay monochrome monograms (§12).
- **Blue is not a second brand accent.** It is a semantic live-execution signal and never
  decorates, fills a primary button, or replaces gold focus/selection.

---

## 3. Token architecture — three tiers

The board asked for "a shared design-token layer so both themes derive from the same
tokens". That is three tiers, and only the middle one flips.

```
tier 1  PRIMITIVES      --lw-obsidian-900 … --lw-gold-500 …
        raw ramps. No semantics. Identical in both themes. Never referenced
        by a component.
                │
                ▼
tier 2  SEMANTIC        --lw-ground, --lw-ink, --lw-accent, --lw-signal-alert …
        role names. THE ONLY TIER THAT FLIPS between light and dark.
        Components reference these and nothing else.
                │
                ▼
tier 3  COMPONENT       --lw-node-fill, --lw-edge-warp, --lw-edge-weft …
        aliases of tier 2 with a name a builder can grep for. Identical in
        both themes because tier 2 already resolved the theme.
```

**The rule that makes this worth having:** a component may reference **tier 2 or tier 3
only**. If a component file contains a hex value or a tier-1 name, it is a bug, and it is a
bug that will only show up in one theme — which is why it is worth a review check
(§16).

Declaration shape in `ui/src/index.css`. Tailwind v4 has no JS config, so the semantic tier
is declared inside `@theme` (which generates the utilities: `bg-ground`, `text-ink`,
`border-hairline`, `text-accent`…) and the dark override reassigns the same custom
properties under a class:

```css
@import "tailwindcss";

/* tier 1 — primitives. Plain :root vars, deliberately NOT in @theme:
   they must not generate utilities, because no component may use them. */
:root {
  --lw-obsidian-950: #08080A;  --lw-obsidian-900: #101013;
  --lw-obsidian-850: #131316;  --lw-obsidian-800: #1E1E23;
  --lw-graphite-600: #666259;  --lw-graphite-500: #85817A;
  --lw-graphite-400: #A9A59C;  --lw-bone-100:     #F5F3EE;

  --lw-paper-50:  #FAF8F3;  --lw-paper-0:   #FFFFFF;
  --lw-paper-200: #DFD9CD;  --lw-stone-400: #8B857C;
  --lw-stone-600: #6E6862;  --lw-stone-700: #56524A;
  --lw-ink-950:   #17150F;

  --lw-gold-200: #E9C46A;  --lw-gold-400: #D8A93C;
  --lw-gold-500: #AD8A20;  --lw-gold-600: #8A6A16;
  --lw-gold-700: #8C7130;  --lw-gold-tint-dark: #1A1508;
  --lw-gold-tint-light: #F5F0E4;  --lw-brass-450: #9C8440;

  --lw-red-400: #F2635C;   --lw-red-600: #C0342E;
  --lw-jade-400: #4FC98D;  --lw-jade-700: #17724A;
  --lw-slate-400: #8C8C98; --lw-slate-600: #605F6B;
}

/* tier 2 — semantic. Light is the default; @theme makes utilities. */
@theme {
  --color-ground:        var(--lw-paper-50);
  --color-ground-dot:    var(--lw-paper-200);
  --color-panel:         var(--lw-paper-0);
  --color-panel-solid:   var(--lw-paper-0);
  --color-ink:           var(--lw-ink-950);
  --color-ink-2:         var(--lw-stone-700);
  --color-ink-3:         var(--lw-stone-600);
  --color-warp:          var(--lw-stone-400);
  --color-accent:        var(--lw-gold-600);
  --color-accent-fill:   var(--lw-gold-500);
  --color-accent-on-fill:var(--lw-ink-950);
  --color-accent-dim:    var(--lw-brass-450);
  --color-accent-tint:   var(--lw-gold-tint-light);
  --color-alert:         var(--lw-red-600);
  --color-ok:            var(--lw-jade-700);
  --color-halt:          var(--lw-slate-600);
  /* non-colour semantics also live here — see §10, §11 */
}

/* tier 2 — dark override. Reassign, never redeclare @theme. */
.dark {
  --color-ground:        var(--lw-obsidian-950);
  --color-ground-dot:    var(--lw-obsidian-800);
  --color-panel:         var(--lw-obsidian-900);
  --color-panel-solid:   var(--lw-obsidian-850);
  --color-ink:           var(--lw-bone-100);
  --color-ink-2:         var(--lw-graphite-400);
  --color-ink-3:         var(--lw-graphite-500);
  --color-warp:          var(--lw-graphite-600);
  --color-accent:        var(--lw-gold-200);
  --color-accent-fill:   var(--lw-gold-400);
  --color-accent-on-fill:var(--lw-obsidian-950);
  --color-accent-dim:    var(--lw-gold-700);
  --color-accent-tint:   var(--lw-gold-tint-dark);
  --color-alert:         var(--lw-red-400);
  --color-ok:            var(--lw-jade-400);
  --color-halt:          var(--lw-slate-400);
}
```

`hairline` is not a colour token — it is a channel-alpha token, because a 10%-black border
and a 10%-white border are the same design decision expressed against two grounds:

```css
@theme { --color-hairline: color-mix(in srgb, var(--lw-ink-950) 10%, transparent); }
.dark  { --color-hairline: color-mix(in srgb, #FFFFFF 9%, transparent); }
```

---

## 4. Tier 2 — the full semantic palette

Values below are **verified**, not proposed: every ratio in the two right-hand columns was
computed against that theme's `ground` and `panel-solid` with the WCAG 2.1 relative-luminance
formula. The engineer does not need to re-derive them; the engineer needs to not change them.

### Dark ("obsidian")

| Semantic token | Hex | Role | vs `ground` | vs `panel-solid` |
|---|---|---|---|---|
| `ground` | `#08080A` | canvas ground | — | — |
| `ground-dot` | `#1E1E23` | dot grid | 1.21 | — |
| `panel` | `#101013` | floating panel fill, used at 72% + blur | 1.14 | — |
| `panel-solid` | `#131316` | popovers, inputs, node fill | 1.24 | — |
| `hairline` | `#FFF` @ 9% | 1 px borders, dividers | — | — |
| `ink` | `#F5F3EE` | primary text | **18.05** | **16.72** |
| `ink-2` | `#A9A59C` | secondary text | **8.15** | **7.55** |
| `ink-3` | `#85817A` | tertiary text, disabled, `idle` | **5.16** | **4.78** |
| `warp` | `#666259` | configured edge, dormant handles | **3.29** | 3.05 |
| `accent` | `#E9C46A` | gold: lines, rings, text, glyphs, the weft | **11.98** | **11.10** |
| `accent-fill` | `#D8A93C` | gold: the one filled primary action | **9.21** | 8.53 |
| `accent-on-fill` | `#08080A` | label on `accent-fill` | — | **9.10** on fill |
| `accent-dim` | `#8C7130` | aged weft | **4.31** | 3.99 |
| `accent-tint` | `#1A1508` | gold-tinted fills (confirmed edge, hover row) | 1.16 | — |
| `live` | `#6AB8FF` | running agent perimeter, streaming result, live evidence edge | **9.45** | **8.75** |
| `live-dim` | `#2F7DD3` | secondary live stroke | **4.76** | **4.41** |
| `live-tint` | `#0A2038` | non-text live backing | 1.23 | — |
| `alert` | `#F2635C` | error, `failed`, destructive, anomaly, refusal | **6.40** | **5.93** |
| `ok` | `#4FC98D` | `succeeded`, saved | **9.60** | **8.89** |
| `halt` | `#8C8C98` | `stopped`, read-only | **6.02** | **5.58** |

### Light ("quarry")

| Semantic token | Hex | Role | vs `ground` | vs `panel-solid` |
|---|---|---|---|---|
| `ground` | `#FAF8F3` | canvas ground | — | — |
| `ground-dot` | `#DFD9CD` | dot grid | 1.32 | — |
| `panel` | `#FFFFFF` | floating panel fill, 72% + blur | 1.06 | — |
| `panel-solid` | `#FFFFFF` | popovers, inputs, node fill | 1.06 | — |
| `hairline` | `#17150F` @ 10% | 1 px borders, dividers | — | — |
| `ink` | `#17150F` | primary text | **17.20** | **18.25** |
| `ink-2` | `#56524A` | secondary text | **7.32** | **7.77** |
| `ink-3` | `#6E6862` | tertiary text, disabled, `idle` | **5.18** | **5.50** |
| `warp` | `#8B857C` | configured edge, dormant handles | **3.44** | 3.66 |
| `accent` | `#8A6A16` | gold-as-bronze: lines, rings, text, the weft | **4.76** | **5.06** |
| `accent-fill` | `#AD8A20` | brass: the one filled primary action | **3.08** | 3.26 |
| `accent-on-fill` | `#17150F` | label on `accent-fill` | — | **5.59** on fill |
| `accent-dim` | `#9C8440` | aged weft | **3.42** | 3.63 |
| `accent-tint` | `#F5F0E4` | gold-tinted fills | 1.14 | — |
| `live` | `#175CD3` | running agent perimeter, streaming result, live evidence edge | **5.64** | **5.99** |
| `live-dim` | `#2F7DD3` | secondary live stroke | **3.96** | **4.20** |
| `live-tint` | `#EAF2FF` | non-text live backing | 1.08 | — |
| `alert` | `#C0342E` | error, `failed`, destructive, anomaly, refusal | **5.25** | **5.57** |
| `ok` | `#17724A` | `succeeded`, saved | **5.59** | **5.93** |
| `halt` | `#605F6B` | `stopped`, read-only | **5.91** | **6.28** |

**Gold in light mode is bronze, and that is correct.** Gold's accessible ceiling on a warm
ivory ground is about 4.8:1 (`#8A6A16`); anything brighter fails text contrast, and a
brighter gold "fixed" by adding a dark outline is two design decisions pretending to be one.
So light mode expresses the same material at a lower value — the way gilt looks on paper
rather than on stone. The two themes are one system because they share the *hue and the
role*, not the lightness. Do not brighten light-mode gold to make it "match" the dark
mockup; that is the one change that breaks the accessibility floor.

**Three verified rules that fall out of the numbers:**

1. `accent-fill` in light (`#AD8A20`, 3.08:1 against ground) is at the non-text floor. It is
   legal **only as a filled control ≥ 32 px with an `accent-on-fill` label**. It is never a
   1.5 px stroke and never text.
2. Text on `accent-tint` is **always `ink`** (16.40:1 dark, 16.05:1 light). Never `accent` on
   `accent-tint` — that lands at 4.45:1 in light and fails.
3. `ground-dot` is below 3:1 in both themes **by design**. The grid is texture, carries no
   information, and CANVAS_SPEC §7.1 requires it stay faint. It is the only sub-3:1 value in
   the system and it must stay the only one.

---

## 5. What each colour means — the semantic contract

Read this as law, not guidance. A reviewer can fail an implementation with it.

| Meaning | Token | Where it appears |
|---|---|---|
| **Act here / selected** | `accent` / `accent-fill` | selection ring · keyboard focus · the one primary button · `entrypoint` ring · observed weft · unfinished validation · pipeline step numbers |
| **Executing now** | `live` / `live-dim` / `live-tint` | running/starting agent border and glyph · streaming result · newly materialized evidence edge |
| **Wrong** | `alert` | `failed` · schema/semantic validation error · destructive confirm · observed anomaly · Team Bus guard refusal · disk conflict bar · parse failure |
| **Finished well** | `ok` | `succeeded` · "Saved" confirmation |
| **Deliberately not running** | `halt` | `stopped` · read-only bar · unsupported `schemaVersion` |
| **Structure** | `warp` | configured edges · dormant handles · ghost node outline |
| **Everything else** | `ink` / `ink-2` / `ink-3` | all text, all glyphs, `idle`, `unavailable`, harness monograms |

**Gold absorbs the v1 selection and attention roles** — `iris` (brand/selected) and
`copper` (attention), plus part of `iris-soft` (hover). Live execution is deliberately
split to `live` blue. The v1 `iris-deep` / `iris-soft` split is deleted; observed edge
*kind* is now carried by stroke pattern and marker, which §13 shows is already sufficient
and which frees the palette.

**Unfinished is gold, wrong is red.** CANVAS_SPEC §5.4's two-weight validation model is
preserved exactly, with `copper` → `accent`: a required-but-never-filled field gets a 1 px
gold border and a `Required` note; a field filled with something invalid gets a 1 px red
border and a message. Both block the save. Greeting a fresh node with red punishes the
operator for the action the product just told them to take; gold says *unfinished*, and gold
already means *act here*, so the vocabulary got smaller and more consistent at once.

---

## 6. Typography

Self-hosted and bundled into `dist/`. No CDN request, ever (CANVAS_SPEC §0).

| Family | Package | Weights / subset | Used for |
|---|---|---|---|
| **Inter Variable** | `@fontsource-variable/inter` | variable, latin | everything UI |
| **JetBrains Mono** | `@fontsource/jetbrains-mono` | 400, 500, latin | everything mono |
| **Instrument Serif** | `@fontsource/instrument-serif` | 400, latin | `display` only — the wordmark and the first-run headline |

**The serif is a proposal, and it is cheap.** One 400-weight latin file (~18 KB woff2), used
on exactly two strings in the product: the first-run wordmark and the first-run headline
(CANVAS_SPEC §10.1). It is what makes the empty state feel like a considered tool rather
than a dashboard, and it appears nowhere else, so it cannot leak into the UI. **If the board
or the engineer declines the third font, the fallback is Inter at 600 weight and −0.03em
tracking** and nothing else in this document changes. Flagged here rather than assumed.

| Step | Size / line | Weight · tracking | Family | Used for |
|---|---|---|---|---|
| `display` | 34 / 38 | 400 · −0.01em | serif | first-run headline and wordmark only |
| `title` | 19 / 26 | 600 · −0.01em | sans | inspector header, dialog titles |
| `body` | 14 / 20 | 400 / 500 | sans | inspector fields, panel rows |
| `node` | 15 / 20 | 550 · −0.01em | sans | the agent node's name — the one thing on the canvas that must read at a glance |
| `ui` | 13 / 18 | 500 | sans | buttons, chips, menu items |
| `meta` | 12 / 16 | 400 | sans | node role line, captions, help text |
| `micro` | 11 / 14 | 600 · +0.07em · uppercase | sans | group headers, badges, counts, `ENTRY` |
| `mono` | 12 / 17 | 400 | mono | ids, model strings, paths, YAML, tool names |
| `mono-sm` | 11 / 15 | 400 | mono | node meta row, edge midpoint pill |

Changes from v1, with reasons: `display` grew 28 → 34 and switched family (it is used once,
so it should be worth using); a `node` step was added because the node name was previously
`body`, the same step as an inspector label, which is the wrong hierarchy for the product's
single most important object; `mono` line-height went 16 → 17 so paths in the inspector stop
touching their box.

**Mono is semantic, not stylistic** (unchanged from v1): anything the operator could type
into the YAML file verbatim — agent `id`, `model`, `spawn.cmd`, `cwd`, env keys, paths — is
mono. Prose is never mono.

**Numerals.** `font-variant-numeric: tabular-nums` on every count badge, step
number and duration, so numbers do not shift width as they change. This is one line of CSS
and it is the difference between a live counter looking calm and looking broken.

---

## 7. Space, radius, elevation, and the grid

- **Space — 4 px base, eight steps only:** `4 · 8 · 12 · 16 · 20 · 24 · 32 · 48`. v1's
  64 is deleted (nothing needed it) and 20 is added (it is the correct panel padding at
  288 px width; 16 was tight and 24 wasted the panel).
- **Panel geometry:** panels inset **20 px** from the viewport edge (was 16 — the canvas is
  the product and 20 reads as deliberate margin rather than a gap); panel padding 20 px;
  section gap 20 px; row height 40 px; 6 px between rows; 12 px row padding.
- **Radius:** `xs` 4 (badges, count pills) · `sm` 8 (inputs, small buttons) · `md` 10
  (rows, cards) · `lg` 14 (floating panels, nodes) · `full` (pills, status dots). v1's 6 px
  `sm` becomes 8 to sit correctly inside a 10 px row.
- **Stroke:** hairlines are always exactly 1 px (never 0.5, never 2) except the three
  documented exceptions: selection ring 2 px, node status rail 3 px, `handoff` weft 2.5 px.

### Elevation is specified twice, because dark and light do not share a model

| Level | Light | Dark |
|---|---|---|
| `e1` floating panels (Library, chip, inspector, mode pill, view controls) | `panel` @ 72%, `backdrop-blur(20px)`, 1 px `hairline`, `0 1px 2px rgb(0 0 0/.04), 0 8px 24px rgb(0 0 0/.08)` | `panel` @ 76%, `backdrop-blur(20px)`, 1 px `hairline`, **`inset 0 1px 0 rgb(255 255 255/.07)` rim light**, `0 8px 32px rgb(0 0 0/.55)` |
| `e2` popovers, palette, the one dialog | `panel-solid` **opaque**, 1 px `hairline`, `0 2px 4px rgb(0 0 0/.06), 0 16px 40px rgb(0 0 0/.14)` | `panel-solid` **opaque**, 1 px `hairline`, rim light as above, `0 2px 6px rgb(0 0 0/.5), 0 24px 64px rgb(0 0 0/.7)` |
| `e3` | — does not exist. Nothing stacks three deep. | — |

**Why the rim light.** On a `#08080A` ground, a drop shadow is invisible and a 9%-white
border alone makes a panel look like a wireframe. A 1 px top-inset highlight reads as a
physical edge catching light and is the single cheapest thing that makes dark mode look
built rather than inverted. It is **top-inset only** — a full inset ring reads as an
embossed 2007 button.

**Never blur text the operator is being asked to read carefully.** `e2` is opaque in both
themes. That is why the palette, the problems popover and the parse dialog are `e2`.

### Bloom — dark mode only

In dark, the live weft carries a 6 px `accent` blur and the `running` halo carries the same
6 px treatment in `live`, both at 22% alpha (`filter: drop-shadow(0 0 6px …)`). The first
makes a gold thread look lit rather than painted; the second keeps blue exclusively tied to
execution. Both are **suppressed entirely in light mode** (glow on paper looks like a
rendering bug) and **suppressed under `prefers-reduced-motion`** together with the motion
they accompany. Bloom is the only effect in the product that exists in one theme and not
the other, and it is allowed because the physical metaphor differs: light catches on stone,
not on paper.

---

## 8. Colour discipline — four laws

1. **Gold is semantic, never decorative.** A button is not gold because buttons are coloured
   somewhere else. The single primary action is gold because it is the operator's current
   action; active execution remains blue.
2. **One gold fill per screen. Gold as a line is unlimited.** This is the law that lets gold
   carry three roles without the screen turning yellow: `accent-fill` (a solid gold plane
   with a dark label) appears **at most once** — the primary action of the current state. All
   other gold is **stroke, ring, dash, glyph, 1 px border, or tint** — the weft, the
   selection ring, the entry ring, step numbers, the focus ring, an unfinished field's
   border. A reviewer can check this from a screenshot.
3. **Never signal with colour alone** (CANVAS_SPEC Principle 5, restated because v2's palette
   is smaller and therefore leans harder on it). Every status, edge layer and edge kind is
   distinguished by at least **two** of {colour, shape, stroke pattern, motion}. §13 proves
   it for the edge layers; §12 proves it for status.
4. **`alert` never decorates and never counts.** Red appears only on something that is
   wrong. A red badge showing a quantity — "3 agents" — is forbidden, because it trains the
   operator to ignore red.

---

## 9. Motion

| Name | Duration | Easing | Applies to |
|---|---|---|---|
| `instant` | 90 ms | `cubic-bezier(.2,0,0,1)` | hover, press, focus ring |
| `quick` | 160 ms | `cubic-bezier(.2,0,0,1)` | panel collapse, inspector slide, tooltip, popover |
| `move` | 240 ms | `cubic-bezier(.2,0,0,1)` | mode change, node drop settle, auto-layout |
| `entrance` | 320 ms | `cubic-bezier(.2,0,0,1)` | first-run composition, conflict bar, **theme switch** |
| `flow` | 1400 ms | `linear`, infinite | observed weft dash travel |
| `breathe` | 2400 ms | `ease-in-out`, alternate | `running` node halo |
| `settle` | 900 ms | `cubic-bezier(.2,0,0,1)` | the save-to-disk ledger sweep (UX_REDESIGN §6) |

Exits use `cubic-bezier(.4,0,1,1)` at 0.75× the entrance duration.

**Two motion laws.** Nothing animates position *and* opacity *and* scale at once — pick two.
And nothing on the canvas animates while the pointer is panning or zooming; the canvas
transform owns motion during navigation.

`breathe` slowed 2000 → 2400 ms. At 2 s a room full of idle-but-running nodes pulsed at
roughly a resting heart rate and read as urgent; 2.4 s reads as breathing.

### The theme switch is an animation, because it is the feature the board asked to feel

320 ms `entrance`, and it is composed rather than a class flip:

1. `ground` and `panel` cross-fade their custom-property values (`transition: background-color`).
2. A single **gold sweep** — a 1 px `accent` line at 30% alpha — travels once across the
   canvas from the toggle's position to the far edge over 320 ms and dissipates. One line,
   one pass, no repeat. It is the weft crossing the cloth as the cloth changes colour.
3. Text, hairlines and accents cross-fade on the same curve. Nothing moves position.

Under `prefers-reduced-motion: reduce`: **no sweep**, and the colour cross-fade collapses to
a 120 ms opacity settle. The theme still changes; it just does not travel.

---

## 10. Reduced motion

Under `prefers-reduced-motion: reduce`, unchanged in intent from CANVAS_SPEC §12.2 and
restated with v2's tokens:

- Observed weft **stops travelling**, renders as a static dash in `accent`, and its count
  badge is always visible. The layer distinction survives on colour + stroke + geometry (§13).
- Bloom is removed with the motion it accompanies.
- The coincidence shuttle becomes an immediate `accent-tint` fill + count badge.
- `running` border becomes a static 2 px `live` perimeter with a `live-tint` outer ring;
  the visible `RUNNING` / `STREAMING` word and glyph remain.
- Panel, inspector and popover transitions become instant opacity changes.
- The mode-switch sequence plays as one cross-fade, no rotation, no stagger; the explanatory
  line still appears.
- The theme sweep is removed (§9).
- Auto-layout applies instantly.

---

## 11. The theme toggle

The board asked for a toggle, and CANVAS_SPEC only had `Toggle theme` buried in ⌘K. It now
has a permanent, discoverable home that costs 32 px of chrome.

- **Affordance:** a 4th button in the bottom-right view-control cluster, which grows
  `132 → 168 px`: `−  +  ⤢  ◐`. (The minimap toggle `▣` moves into ⌘K; a minimap that is
  off by default does not deserve permanent chrome, and the theme toggle does.)
- **Glyph:** `Sun` in dark mode, `Moon` in light mode — the glyph shows **where the click
  goes**, not the current state, and the tooltip says so: *"Switch to light"* / *"Switch to
  dark"*. Showing current state on a two-state control is the classic ambiguity and it is
  avoided by naming the destination.
- **Shortcut:** `⌘⇧L`. In ⌘K: `Switch to dark / light` plus a third entry
  `Follow system appearance`.
- **Three states, two of them in the palette.** The toggle is binary (light ⇄ dark). The
  third state — follow system — is set from ⌘K and shown as a hairline dot under the toggle
  glyph. Persisted per browser in `localStorage` under `loomwatch.theme` =
  `"light" | "dark" | "system"`; default `"system"`.
- **No flash on load.** The theme class is applied by a tiny inline script in `index.html`
  before first paint, reading `localStorage` then `prefers-color-scheme`. A dark-mode user
  seeing a white flash on every load is the single most common failure of this feature.
- **`<meta name="theme-color">`** is updated with the theme so the PWA's standalone window
  chrome matches (`#08080A` / `#FAF8F3`).

---

## 12. Iconography and status

`lucide-react` (MIT, tree-shaken, bundled). 16 px / stroke 1.5 in panels; 18 px / stroke 1.5
on nodes. No other icon set, no illustration. (v1 said 20 px on nodes; 18 balances better
against the new 15 px `node` type step.)

**Harness marks stay monochrome monograms** — a 20 px `md`-radius chip, 1–2 mono characters,
`ink-2` on a `hairline` fill, both themes. LoomWatch ships no vendor trademark art, and a
per-vendor hue would spend saturated colour on something that means nothing (§8, Law 1).
Keyed on the `id` from `GET /api/harnesses`: `claude` → `C`, `codex` → `Cx`,
`gemini` → `G`, `opencode` → `Oc`, custom endpoint → `·`.

Role glyphs on nodes: fixed lucide map on a lowercase substring of `Agent.role`, `Circle`
fallback — `research`→`Telescope`, `review`→`ScanEye`, `write`/`author`→`PenLine`,
`test`/`qa`→`FlaskConical`, `build`/`engineer`→`Hammer`, `plan`/`lead`→`Compass`,
`design`→`Shapes`.

### Status — shape and colour, both, always

The eight values of `Agent.status`. Shape is the primary channel so the table survives
greyscale and colour-blindness (§8, Law 3):

| Status | Shape | Colour | Motion |
|---|---|---|---|
| `idle` | hollow ring, 1.5 px | `ink-3` | none |
| `starting` | hollow ring + 90° arc + `STARTING` | `live` | arc rotates, 1200 ms linear |
| `running` | filled dot + `RUNNING` / `STREAMING` | `live` | full node border breathes, 2400 ms |
| `waiting` | hollow **diamond** + `QUEUED` | `halt` | none — it waits on a handoff, and motion would imply progress |
| `succeeded` | filled circle + check | `ok` | none |
| `failed` | filled circle + × | `alert` | none |
| `stopped` | filled **square** | `halt` | none |
| `unavailable` | **dashed** hollow ring | `ink-3` @ 40% | none |

`running` is blue; `waiting` is neutral. Shape and visible words remain authoritative, so
both states survive greyscale and reduced motion. On run screens the task line names the
work currently executing, and `DONE`, `ERROR`, `CANCELLED`, and `OFFLINE` stay visible when
the perimeter changes to semantic green, red, slate, or dashed neutral.

The node's 3 px left status rail carries the same colour at full value, so status stays
legible at zoom levels where a 12 px indicator does not.

**In Phase 04 every node is `idle`.** The table is specified now so Phase 05 does not
re-invent it and so the rail and indicator space is designed in from the start.

---

## 13. The two edge layers — warp and weft

ARCHITECTURE §5's named requirement: *"configured edges (solid, drawn by the user, real
constraints) and observed edges (animated, derived from Team Bus events)"* must be
distinguishable at a glance. v2 keeps v1's four-channel separation and improves the
contrast between the layers by moving observed activity onto gold, which is further from
neutral graphite than violet was.

| Channel | Configured (warp) | Observed (weft) |
|---|---|---|
| **Colour** | `warp` — neutral graphite | `accent` — gold, or `alert` when anomalous |
| **Stroke** | solid, 1.5 px | dashed; pattern varies by kind |
| **Motion** | static, always | dashes travel (`flow`) |
| **Geometry** | the direct smoothstep path | offset 14 px perpendicular, or a wider curve where no configured path exists |
| **Depth** (dark only) | flat | 6 px bloom at 22% |

In one line: **structure is a quiet grey solid line; activity is a travelling gold dashed
line beside it.**

| Layer · kind | Stroke | Colour | Marker | Motion |
|---|---|---|---|---|
| configured · `sequence` | 1.5 px solid | `warp` | filled arrowhead, 8 px | none |
| observed · `dispatch` | 1.5 px dash `6 4` | `accent` | open arrowhead | `flow` → |
| observed · `ask` | 1.5 px dash `2 3` | `accent` @ 80% | open arrowheads **both ends** | `flow` alternating ⇄, 1400 ms each way |
| observed · `handoff` | 2.5 px dash `10 4` | `accent` | double chevron ≫ | `flow` → **once** on arrival, then static |
| observed · anomaly | 1.5 px dot `1 4` | `alert` | open arrowhead + ⚠ midpoint badge | `flow` → |

The three observed kinds are separated by **dash pattern, stroke weight and marker** rather
than by three shades of gold. v1 used `iris` / `iris-soft` / `iris-deep`, three violets a
step apart, which was never legible at canvas zoom — a `2 3` dot pattern with arrowheads at
both ends is unmistakable at any zoom, and it deletes two tokens.

**Greyscale proof** (the §16 acceptance test): drop all colour and the five rows remain
`solid+filled arrow` / `6 4 dash` / `2 3 dash, two arrows` / `10 4 heavy dash, chevron` /
`1 4 dot, ⚠`. Five distinct rows, no colour used.

**When the layers coincide** (unchanged from CANVAS_SPEC §6.3, retokenised): do **not** draw
a second line. The configured edge gains a 24 px `accent` **shuttle** travelling
source → target along its own path, one pass per observed event, queued if several arrive;
afterwards the edge holds an `accent-tint` fill and a `micro` count badge (`×3`) with `ink`
text at its midpoint. Reduced motion: no shuttle, tint and badge appear immediately.

**Ageing:** the weft is at full value while its source node is `running` and fades to
`accent-dim` over 4 s after its last event, so the live frontier of the graph is the
brightest thing on screen without anything being highlighted. Observed edges are runtime
data, never written to the team file.

---

## 14. Migration map — v1 token → v2 token

Mechanical, so the engineer can migrate `ui/src/` with a find-and-replace pass and a review,
not a redesign.

| v1 | v2 | Note |
|---|---|---|
| `canvas` | `ground` | renamed — "canvas" is the product's own noun and was confusing as a colour |
| `canvas-dot` | `ground-dot` | |
| `surface` | `panel` | |
| `surface-solid` | `panel-solid` | |
| `hairline` | `hairline` | now a `color-mix` alpha token, not a hex |
| `ink`, `ink-2`, `ink-3` | same names, new values | light `ink-3` was 4.52:1 → now 5.18:1 |
| `stroke` | `warp` | renamed to the motif; dark value raised to clear 3:1 |
| `iris` | `accent` | **plus** the fill/line split in §8 Law 2 |
| `iris-soft` | *deleted* | hover fills → `accent-tint`; observed `ask` → dash pattern |
| `iris-deep` | *deleted* | observed `handoff` → 2.5 px `10 4` dash + chevron |
| `copper` | `accent` | attention is now gold; see §5 |
| `green` | `ok` | |
| `red` | `alert` | |
| `slate` | `halt` | |
| — | `accent-fill`, `accent-on-fill`, `accent-dim`, `accent-tint` | new |

Net: 15 colour tokens → 16, with two accents collapsed to one and two observed-edge shades
deleted. `ui/src/index.css` currently declares the v1 set at lines 5–41 and is the only file
that needs new values; component files need the rename pass.

---

## 15. What this document does **not** change

Stated explicitly so the review is bounded and so no one reads a visual revision as a licence
to redesign behaviour:

- CANVAS_SPEC §1 principles — all five stand and v2 is written to pass them.
- CANVAS_SPEC §9 YAML round-trip semantics, including no autosave and the CST-preserving
  save (§9.4's withdrawal of the reformat modal stands).
- The frozen WebSocket schema. Nothing here derives a new event kind or field; the observed
  layer is still derived exactly as CANVAS_SPEC §6.5 specifies.
- `schemas/team.schema.yaml`. No new persisted field. Node position persistence is still the
  open operator decision at CANVAS_SPEC §7.3 / §15.1.
- Scope: configuration only. No mid-run execution control (ARCHITECTURE §6).
- CANVAS_SPEC §15's open decisions, all of which survive this revision unchanged.

---

## 16. Acceptance — how a reviewer fails this

The visual language is done when all eight hold. Six are checkable from two screenshots.

1. **Contrast.** Every value in §4 measured in the built app matches the table to ±0.05.
   `ground-dot` is the only sub-3:1 value.
2. **One gold fill.** In a screenshot of any populated state, exactly one element is filled
   with `accent-fill`. Everything else gold is a line, ring, dash, glyph or tint.
3. **Greyscale edges.** A greyscale screenshot of a canvas carrying both layers keeps them
   distinguishable (§13's five-row proof).
4. **No tier-1 leakage.** No component file references a `--lw-*` primitive or a hex value.
   `rg -n '#[0-9a-fA-F]{6}' ui/src --glob '!index.css'` returns nothing.
5. **Panel width.** No panel exceeds 320 px; the canvas is ≥ 70% of the viewport in every
   state (CANVAS_SPEC Principle 1).
6. **No flash.** Loading the app in dark mode never shows a light frame (§11).
7. **Reduced motion.** With the media query forced, the app has no travelling dashes, no
   bloom, no sweep — and both edge layers are still distinguishable.
8. **No network.** DevTools offline: no font, icon or asset request leaves the page.
