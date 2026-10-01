# LoomWatch design system bundle

A self-contained copy of LoomWatch's design system ("Obsidian & Gilt"). Use it to design
LoomWatch screens in **Claude Design** (claude.ai/design) or any other tool outside the
codebase. Nothing in `ui/` imports it. The app's source of truth is still
`ui/src/styles/` and [`docs/DESIGN_LANGUAGE.md`](../DESIGN_LANGUAGE.md).

| Path | What it is |
|---|---|
| [`DESIGN.md`](DESIGN.md) | **Start here.** The brief: product, thesis, colour laws, type, layout, components, motion, voice, do/don't, and where the spec and the shipped UI disagree. Its YAML front matter holds the tokens in Google's DESIGN.md format. |
| [`tokens.css`](tokens.css) | The app's tokens (primitives → semantic → component aliases, type scale, `.e1`/`.e2`, focus). Generated, so don't edit it. |
| [`components.css`](components.css) | The component kit: buttons, fields, badges, status, canvas cards, edges, library rows, inspector, composer, ⌘K, bars, Home cards, team sentence, agent marks, timeline, receipt. Uses tokens only. |
| `fonts/` | Self-hosted Inter, JetBrains Mono, and Instrument Serif (woff2), plus `fonts.css`. |
| `preview/*.html` | 12 reference cards, each showing dark and light side by side. The first line of each is an `@dsCard` marker for Claude Design's Design System pane. |
| `screenshots/` | The real app at 1440 × 900: Home, Build, and Run, in dark and light. |
| `tools/` | Scripts that refresh everything above from `ui/`. |

## Using it in Claude Design

1. **Set up a design system in Claude Design** from this folder. Two ways:
   - From Claude Code, run `/design-sync` in this repo and pick `docs/design-system/` as the
     source. It pushes the bundle into a claude.ai/design design-system project, one file at
     a time, after you approve the plan.
   - Or create the design-system project in claude.ai/design and add this folder's files
     yourself. Include at least `DESIGN.md`, `tokens.css`, `components.css`, `fonts/`,
     `preview/` and `screenshots/`.
2. In prompts, say which surface you're designing (Home, Build, Run, or a new one) and which
   theme. Dark is the default. Ask for the light variant from the same markup.
3. Mockups should load `fonts/fonts.css`, `tokens.css` and `components.css`, and set
   `data-theme` on `<html>`. Component aliases such as `--lw-node-fill` resolve at `:root`, so
   a `data-theme` set on an inner element only re-themes tier-2 tokens. The preview cards
   work around this in `preview/card.css`.

## Keeping it current

Run these from the repo root after changing the UI's styles:

```bash
sh docs/design-system/tools/sync.sh
```

```bash
node docs/design-system/tools/build-previews.mjs
```

The first copies tokens and fonts from `ui/`. The second regenerates the preview cards; edit
the generator, not the HTML. If you changed a component, also update `components.css` and the
component sections of `DESIGN.md` by hand.

To refresh the screenshots, start the daemon and the UI dev server (port 5173), edit
`tools/screens.json` if the example run id no longer exists, then run:

```bash
node docs/design-system/tools/shoot.mjs docs/design-system/tools/screens.json
```

`shoot.mjs` drives your installed Google Chrome headlessly; it needs no npm install. Set
`CHROME_BIN` if Chrome isn't in `/Applications`.
