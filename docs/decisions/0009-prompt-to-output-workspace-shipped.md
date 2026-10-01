# 0009 — The prompt-to-output workspace and the Obsidian & Gilt design shipped

- **Date:** 2026-09-11
- **Status:** Shipped
- **Supersedes in part:** ADR 0004's Phase 04 canvas (visual language and shell), the
  standalone `/watch` page
- **Implements:** the board-approved TNG-87 design (`docs/DESIGN_LANGUAGE.md`,
  `docs/UX_REDESIGN.md`, `docs/TNG89_INTERACTION.md §12`) and ADR 0008's run API
- **Superseded in part, 2026-09-13:** decisions 1 and 3 below. `TNG89_INTERACTION.md §15`
  merged the two views into one canvas — the configured graph never moves and a run is drawn
  onto it — and `ui/src/lib/runs/storyLayout.ts` is retired in favour of
  `ui/src/lib/runs/runOverlay.ts` (two docked anchors and one agent's fanned evidence, no
  layout of its own). Everything else here still stands. See
  `docs/TEAM_MEMORY.md#implementation-status`.

## Context

The Phase 04/05 UI did not follow the design the board approved: it kept the rev-1 violet
palette, a separate list-and-timeline `/watch` page, no composer, and no way to start a run
from the browser. The operator's goal is to replace a chat app with LoomWatch: type a goal,
watch the breakdown of the agent pipeline from prompt to response as a graph.

## Decisions

1. **One workspace, two views.** `ui/src/components/Workspace.tsx` owns both the team
   canvas (compose) and the run story (run). A run is entered through the composer, the
   history popover or `?run=<id>`; leaving it restores the team's own node positions.
   `/watch` and `/watch?session=` redirect into the workspace.
2. **The graph is projected, never inferred.** `ui/src/lib/watch/events.ts::projectRun`
   is a pure function of archived `RunEvent`s and a replay cursor: agents with task state,
   evidence cards classified by ACP `toolKind` (execute → command, read/edit → file,
   search, fetch → source, Team Bus pair → delegation, permission, plan), the canonical
   responder's last turn as the response, and the run phase. Only the bus-authored
   `Team Bus: <tool>` pair is authoritative; harness echoes are ignored. The operator's
   prompt is peeled from the daemon's role/stage wrappers (`operatorPrompt`).
3. **Deterministic story layout.** `ui/src/lib/runs/storyLayout.ts` places Prompt, Run,
   agents (pipeline order, else lead then first appearance) and a two-column evidence grid
   per agent; positions are view state and an operator's drag re-anchors an agent's
   evidence. Below 768 px the same data renders as a reading column (`RunColumn`).
4. **Tokens lifted verbatim.** `docs/mockups/tokens.css` became `ui/src/styles/tokens.css`
   with the light tier-2 block as Tailwind's `@theme` and dark under
   `[data-theme="dark"]`; `prototype.css` became `app.css` / `runtime.css` with ids turned
   into classes and node/edge rules adapted to React Flow wrappers. Dark is the default;
   `lib/theme.ts` resolves dark / light / system before first paint. Inter, JetBrains Mono
   and Instrument Serif are bundled under `ui/public/fonts` (no network at runtime).
5. **No run without saving.** A dirty document's composer button reads *Save & run*; the
   run is created only after `save()` reports success (`useTeamDocument.save` now returns
   a boolean). Stop calls `POST /api/runs/{id}/cancel`; Retry starts a new run from the
   retained prompt and never overwrites the previous branch.
6. **Honesty over decoration.** Evidence carries owner, ordinal, time, status and relation
   as words; coverage is “Partial capture” unless every category is complete; a harness
   without HTTP MCP is marked *no Team Bus access* on its inspector rather than shouted as
   an alert; the registry's terminal status wins over event-derived phase.

## Deferred

- Provenance capture quality (`recorded` / `derived` / `redacted` / `unavailable`) and the
  companion provenance channel of ADR 0005 — evidence today is exact archive bytes only.
- Skills, tools and knowledge sources in the Library (TNG-122): no discovery API exists.
- Retry lineage (`retryOfRunId`) is client-side for the session only.
- Cancellation archives no terminal event (ADR 0008); the run record is the truth.
