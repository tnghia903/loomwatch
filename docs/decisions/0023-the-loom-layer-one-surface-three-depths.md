# 0023 — The loom layer: one surface, three depths

- **Date:** 2026-10-01
- **Status:** Accepted — implemented in `ui/src/lib/story/`, `ui/src/lib/library/roles.ts`,
  `ui/src/components/workspace/{TeamStory,NeedsYouTray}.tsx`, `ui/src/components/run/{WeftBar,RunReceipt}.tsx`,
  `ui/src/components/home/TeamFabric.tsx`, `ui/src/styles/loom.css`, and small edits to the Build palette,
  agent card, view controls, command palette, Delivery Lane, Home and the New team dialog
- **Builds on:** ADR 0022 (first run in plain language), ADR 0020 (Delivery Lane), `docs/DESIGN_LANGUAGE.md`
- **Proposal:** the "LoomWatch Design Concepts" artifact (2026-10-01)

## Context

LoomWatch serves two audiences with one product: operators who have never heard of ACP or an
entrypoint, and experts who want ids, models, commands and the raw event record. The obvious answer —
a Simple mode and a Pro mode — forks the interface and the vocabulary, and drops people who outgrow
Simple onto a screen they have never seen. A walkthrough on 2026-10-01 also found concrete gaps: the
Build rail offered app names ("OpenClaw", "pi") instead of jobs; a fitted canvas shrank cards below
reading size; the run view ended in badges such as "0/1 required skills with loading evidence"; the
replay control was a bare slider ("latest / 1584"); and a team waiting on the operator was visible only
inside that team's own run.

## Decision: one surface, three depths

Every surface reads as a plain **story** first, lets the operator lean in to the **team**, and lean in
again to the **trace**. Nothing is hidden behind a setting; depth is somewhere you go. Four rules:

1. Plain name first, real name one hover away (titles carry ids and models).
2. Defaults for newcomers, keys for experts — nothing needs the keyboard, everything has a key.
3. Every plain sentence links to its evidence.
4. Fold, never hide.

## What shipped

| Feature | For a newcomer | For an expert | Where |
| --- | --- | --- | --- |
| **Team sentence** | The team in one sentence above the Build canvas ("When you ask, Researcher researches, then you approve…"). Unconnected agents are named, with a one-click repair ("Put Writer after Researcher", "Hand work along in this order instead"). | A sentence that reads wrong is a team wired wrong; names hover to `id · model` and select the agent. | `lib/story/teamSentence.ts`, `TeamStory.tsx` |
| **Hire by job** | The palette leads with jobs (Researcher, Writer, Editor, Reviewer, Coder, Designer, Analyst) placed with working instructions on the best installed app, the app shown as "on Claude". | "AI apps" keeps blank agents; the app, model and brief stay editable. | `lib/library/roles.ts`, `ComponentPalette.tsx` |
| **Story · Team · Trace zoom** | Zoomed out, each card is a name and one sentence in large type ("Editor · Edits", or the live task during a run). | Zoomed in, the card adds id, model, command, folder, budget, skills and the full instructions. A dial jumps between depths, towards the selected or starting agent. | `lib/story/depth.ts`, `BuildNodeCard.tsx`, `ViewControls.tsx` |
| **Weft timeline** | One lane per helper, a thread where it worked, a knot at each handoff; dragging reads the run back with a sentence for each moment. "Read it as a story" narrates the run in order. | Each moment shows its event kind and sequence number and opens the record; ← → step moments. | `lib/story/weft.ts`, `WeftBar.tsx` |
| **Run receipt** | When a run ends: asked, team, time, apps, then who did what, what failed *and what happened instead*, then what is worth a second look. | Every line opens its evidence; "Copy as Markdown" for a PR or ticket. A skill counts as used only when the record shows it opened. | `lib/story/receipt.ts`, `RunReceipt.tsx` |
| **Needs-you tray** | One bell for every team: review steps, questions and recent failures as one-question tickets with "Looks good", "Send back…", "Answer…", showing what was handed over. The tab title counts them and the tab icon carries a dot (red waiting, blue working). | J/K move, A approve, R reply, O open the run. | `lib/story/needsYou.ts`, `useNeedsYou.ts`, `NeedsYouTray.tsx` |
| **Run fabric** | Each Home team card shows its recent runs as woven threads — gold finished, red failed, blue working, a dashed ring waiting — and "Last run 2 h ago · finished". | The rhythm of a schedule and where it broke, per-run tooltips. | `lib/story/fabric.ts`, `TeamFabric.tsx` |
| **Outcome-first templates** | Each template shows an example of what it produces, labelled "Example result". | Unchanged team files. | `templates.ts`, `NewTeamDialog.tsx` |
| **⌘K in two dialects** | Plain words — "add a reviewer", "zoom out", "looks good", "open daily news", "ask the team to …" — become one proposed action shown before it runs. | The same grammar as `/add writer`, `/depth trace`, `/approve`, `/open …`, `/run …`. Offline and deterministic: no model guesses. | `lib/story/intent.ts`, `CommandPalette.tsx` |

Also fixed on the way: the Build canvas in the light theme drew dark-ink names on hard-coded obsidian
cards (invisible); `loom.css` re-points the prototype layer's variables at the semantic tokens in light
mode. The mode-switch banner now says "Your agents now hand work along in the order you connected
them" (the edge vocabulary moved to its tooltip).

## Consequences

- Everything here is presentation over data the UI already had (`RunProjection`, `GET /api/runs`,
  the team document). No daemon or schema change.
- The tray polls `GET /api/runs` every 5 s (15 s in a background tab — the tab title exists for exactly
  that moment). Failures stop showing after 24 h or when dismissed (per browser, `localStorage`).
- The timeline narrates and counts only recorded evidence; agent prose is never paraphrased into a
  claim. In a pipeline a stage's thread ends at its handoff unless the record shows it working later.
- Semantic zoom renders Story and Trace extras only at that depth, so nothing hidden is announced
  twice; `BuildNodeCard.test.tsx` mocks `useStore` with a settable zoom.
- New styles live in `styles/loom.css` and use semantic tokens only.

## Verification (2026-10-01)

532 UI tests (52 new, in `lib/story/` and the agent card), oxlint clean, `vite build` passes. Exercised in
the in-app browser against a scratch daemon with fake ACP harnesses (no model calls): a real run parked
at a review step appeared in the tray from Home, was approved with the A key through the real answer
API, and finished; its receipt, timeline, story and fabric were checked in dark and light themes and at
375 px.
