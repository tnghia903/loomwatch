# 0041 — One canvas on both tabs: one add panel, one bar, one agent panel

- **Date:** 2026-10-03
- **Status:** Accepted. UI only: `ui/src/components/library/ComponentPalette.tsx` (now the only add
  panel), `ui/src/lib/library/observed.ts` (new), `ui/src/components/canvas/{ViewControls,edges,
  BuildInspector,BuildResourceInspector}.tsx`, `ui/src/components/Workspace.tsx`,
  `ui/src/styles/one-canvas.css` (new) and dead rules removed from `app.css`, `chrome.css`,
  `loom.css`, `prototype-parity.css`, `prototype-workspace.css`. Removed:
  `ui/src/components/library/{Library,LibraryRow,usePersistedBoolean}.tsx`. No daemon or schema change.
- **Builds on:** [ADR 0023](0023-the-loom-layer-one-surface-three-depths.md) (one surface, three
  depths) and `ui/src/styles/run-canvas.css` ("one canvas anatomy": both tabs already drew the
  same agent card). **Amends:** [ADR 0039](0039-agent-panel-drops-process.md)'s "two inspectors
  exist": a run now opens the same short panel as Build.

## Context

The operator compared Build with a run's "See every event" trace and asked why they were two
different canvases, and why tools the run had used did not show up in Build.

The cards were already one component. Everything around them was forked on `runView` in
`Workspace.tsx`:

| | Build | Run trace |
| --- | --- | --- |
| Left panel | `ComponentPalette`: "Add to your team" (jobs, AI apps, skills, tools, knowledge), docked | `Library`: a floating glass panel with the LoomWatch brand again, "Agents", an always-empty "Presets", skills and tools with compatibility, and "Observed" rows |
| View controls | the depth dial, a "Fit team" button and a +/−/fit column | one bar: Organize, the dial, −, zoom %, +, fit, theme |
| Edge words | requires · produces · can use | uses skill · responds with · uses tool |
| Agent panel | the short `BuildInspector` | the full `Inspector` |
| Resource panel | a short card, then details | the details straight away |

The tool question had three causes:

1. **The trace listed calls, not tools.** Its "Tools & connectors" group grouped by the raw tool
   name, and fell back to the call's own title. The run's five refused web searches showed as
   "WebSearch ×5", and the five permission answers LoomWatch gave for them showed as five more
   "tools" titled `Search "Model Cards for…"`. Codex's searches had no raw name and showed as a
   third row, "Web search".
2. **Built-in tools are not things you add.** Web search, file edits and commands are part of each
   AI app. Build cannot list them as tools to connect: an agent may use them, or not, through its
   "Allowed without asking" switches (ADR 0037). Nothing in Build said so.
3. **The run hid why its searches failed.** The research team's file predates ADR 0037, so its
   Researcher has no `allow.web`. LoomWatch refused all five searches, and the trace's row said
   only "Observed ×5".

## Decision

1. **One add panel on both tabs.** `ComponentPalette` is the panel; `Library` is deleted. From the
   Library it keeps what was worth keeping: the scan time and "Scan again", a scan error shown
   verbatim with "Try again", each skill's and tool's compatibility (Ready, Compatible, Local only),
   details and agent connections behind an ⓘ button, skeleton rows while the apps load, the daemon's
   error about apps with "Retry", "Not installed · N" with the search path, the empty-knowledge
   pointer to Add folder… / Add file… (ADR 0036), and the privacy line. The brand block, "Presets"
   and the "6 of 7 usable here" count are gone. A row click adds, on both tabs, as Build always did.
   Adding during a run was already a normal edit (§15.2.5).
2. **A run leads with what it used, one row per tool.** `usedInRun` groups the recorded evidence by
   what an operator could connect or switch on, not by call: `WebSearch` from Claude and a titled
   `search` call from Codex are one "Web search" row. A permission answer is never a row. It is
   counted against the call it was asked for, so "Declined 5×: Researcher isn't allowed to search
   the web" names the switch that would have allowed it. Rows say where a tool comes from:
   "Built into the app", "Connected tool", or "LoomWatch" for the Team Bus and team memory. A click
   still fans the agent and opens the first card, and a drag still repositions it. While the panel
   is folded, its button reads "Used in this run · N".
3. **Build says where built-in tools live.** The Tools group ends with "Web search, commands and file
   edits are built into each AI app. Switch them on per agent, under Allowed without asking."
4. **One bar.** `ViewControls` loses its Build variant. The bar sits at the bottom right on both tabs.
   In a run it stands above the composer wherever the two would collide. That replaces the old rule
   that moved it to the top below 1400 px, where the run's timeline strip covered it. On phones the
   zoom buttons give way to pinch.
5. **One set of edge words.** "requires", "produces" and "can use" on both tabs.
6. **One agent panel and one resource panel.** A run opens `BuildInspector`, which now shows what the
   run has the agent doing ("done · Reply delivered"). "Model and more settings" still opens the
   full panel. A fix that sends the operator to a field opens the full panel even when the short
   one is already open. `BuildResourceInspector` opens on its details when the item has no card
   yet.
7. **What still differs is what each tab is for.** Build has its heading, the team sentence and the
   legend. The trace has the timeline, the composer and the layer legend. In a run the Output card
   carries the answer. On phones the trace does not show the add panel, as before.

## Consequences

- A skill or tool row click in the trace now adds it to the team, where it used to open its details.
  Details are one ⓘ away on both tabs.
- At 768–1024 px, opening the agent panel folds the add panel in Build too. The trace already did
  this: the §13 rule "the Library sheet or the inspector, never both" now applies to the one panel.
- ⌘\ (Toggle library) now works in Build. Before, only the trace's Library listened for it.
- Not fixed here: the receipt and the "needs you" tray are the places that offer **Allow from now
  on**. The panel explains a refusal but does not change a switch (ADR 0037, ADR 0040).

## Verification (2026-10-03)

102 UI test files and 901 tests pass. `observed.test.ts` (new) reproduces the research team's run
shape, and `ComponentPalette.test.tsx` carries the Library's behaviours over. `tsc -b` and oxlint
are clean, and `vite build` passes. The research team's real run 3 was checked in the in-app
browser on both tabs: dark and light, at 1600, 900 and 375 px wide. In the trace, "Used in this run"
lists Tool search ×1, Web search ×12 (declined 5×: Researcher isn't allowed to search the web) and
Team Bus · roster ×1 (declined 1×). The old Library listed each of the five permission answers as
a tool of its own.
