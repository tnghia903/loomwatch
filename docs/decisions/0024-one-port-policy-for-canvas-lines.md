# 0024 — One port policy for every canvas line

- **Date:** 2026-10-01
- **Status:** Accepted — implemented in `ui/src/lib/canvas/ports.ts` (policy, tested),
  `ui/src/components/canvas/CardPorts.tsx` (the connection points every card carries),
  `ui/src/components/canvas/route.ts` (drawing), `buildCanvasGraph` (one `assignPorts` pass)
- **Amends:** the per-edge routing in `components/canvas/edges.tsx` and `workspace/canvasGraph.ts`

## Context

The canvas lines looked tangled on both surfaces. Investigation found causes, not one bad edge:

1. **Each section of the graph builder chose its own attachment points.** Resources used a second
   right-side dot at 72 % height and entered capability cards from the left, so a card sitting
   directly below its agent got a right–down–left–down detour. "Responds with" deliberately arced over
   the row even when nothing was in the way. Backward asks were a bezier from right to left, so they
   cut back through the cards between. Every new edge kind added another way to cross a card.
2. **Handles sat at 50 % of each card's height**, and cards on one row have different heights (Build
   vs Run cards, the Output, the Prompt), so even a simple relay stepped up and down.
3. **Replay layout took every observed delegation as an ordering constraint.** A later stage asking an
   earlier one made a cycle; dagre broke it by reversing the stages, which then overlapped the
   docked Prompt and Run cards.
4. **The evidence fan was spaced for 68 px cards that render 89 px tall**, and opened on top of the
   agent's resource cards.
5. **"hands off" was printed on every configured edge.**

## Decision

**One policy, applied once, to every edge** (`assignPorts`, the last step of `buildCanvasGraph`). No
section of the builder picks a handle. Every card carries the same points (`CardPorts`): left in,
right out, bottom out, top in, a low-left trunk, and bridge points on the top and bottom edges. The
policy, from the two cards' boxes:

1. **Stack** — two or more cards hanging below one card in a column → a tree: one trunk on the
   source's left, one branch per card (resources and opened evidence read as one list).
2. **Drop** — a single card below → bottom to top, labelled beside the line.
3. Otherwise the shape that **crosses the fewest other cards**, simplest first on a tie: a **relay**
   (right to left), a **bridge over** the row (top to top), or a **bridge under** it (bottom to
   bottom). A target to the left can only be bridged. Crossing is tested on the segments each shape
   actually draws, so a card merely near a line never forces a detour. Bridge height grows with
   span (`bridgeLift`), shared by the chooser and the renderer, so several bridges nest.

Supporting rules, each at its source:

- Every left and right point sits at `HANDLE_Y` (44 px) from the card's top, and rows are
  top-aligned, so a relay is a straight line.
- Replay layout only takes delegations that run *with* the story's order as constraints.
- The evidence column is left-aligned with its agent, below anything already hanging from it, at the
  card's real height (`DOCK.evidenceH`, pinned in CSS).
- Configured-edge labels appear on selection; relationship words stay where they differ (reads,
  requires, ask, responds with).
- The prototype stylesheet's colours are now derived from the semantic tokens, so the canvas follows
  the theme at its source (it used obsidian literals, which hid card names in light mode).

## Consequences

- A new kind of edge needs no routing code: it is drawn correctly by where its cards are.
- Lines respond to the operator's own arrangement: drag a card into a line's path and the line
  bridges around it on the next render.
- `lib/canvas/ports.test.ts` pins the policy (relay, drop, stack, bridge over, bridge under, and the
  near-but-not-blocking case).
