# 0043 — One control per thing

- **Date:** 2026-10-03
- **Status:** Accepted. UI only, no daemon or schema change.
  - `ui/src/components/workspace/{WorkspaceMenu,BuildHeading,NeedsYouTray,NotionDeliverySettings}.tsx`
  - `ui/src/components/canvas/{DocumentSwitcher,ViewControls,BuildNodeCard,capabilityNode}.tsx`
  - `ui/src/components/run/{DeliveryLane,RunReceipt,LifecycleStrip,NotionSend}.tsx`
  - `ui/src/components/composer/Composer.tsx`, `ui/src/components/memory/MemoryPanel.tsx`
  - `ui/src/components/library/ComponentPalette.tsx`, `ui/src/components/ask/AskPanel.tsx`
  - `ui/src/components/workspace/{canvasGraph,useCanvasGraph}.ts`, `ui/src/lib/story/depth.ts`
  - `ui/src/components/Workspace.tsx`
  - Removed: `canvas/AddSource.tsx` (and its test), `workspace/BuildOutcome.tsx`.
  - Docs: `docs/design-system/DESIGN.md`, `docs/CANVAS_SPEC.md`, `site/main.js`.
- **Amends:**
  - [ADR 0042](0042-sources-on-the-canvas.md) decision 6: the add panel no longer adds folders and
    files.
  - [ADR 0041](0041-one-canvas-on-both-tabs.md) decision 4: the bar loses −, + and Fit.
  - [ADR 0038](0038-send-the-team-response-to-notion.md) decision 1: Connections is linked from the
    menu only.

## Context

A UX review found the Run screen saying the same thing three times. The operator then asked for
the whole product to be checked so that no two items do the same thing.

Each screen was walked in an isolated LoomWatch with a demo team: Home, Build with an agent and a
card selected, a new run, a run waiting on you, a finished run, the full trace, the menu, the team
switcher, the needs-you tray, Memory, Run history, Connections and Ask. A script listed every
visible control with its name and region. Each one suspected of repeating another was read in the
code to see what it called.

## The rule

1. **On any one screen, an action has one visible control.**
2. **That control sits in the same place on every screen it appears on.**
3. **Accelerators are not controls.** Keyboard shortcuts and the ⌘K command palette reach existing
   actions faster; they add no second button.
4. **One object may appear in more than one place.** An agent's name in the team sentence, its
   card, and a source's row in the add panel all stand for that one object. Choosing any of them
   selects it. What the rule forbids is two separate controls that perform the same *action*:
   save, run, remove, approve, open the trace.

## Decision: what was removed, and what stays

| Action | Duplicates found | The one control kept |
| --- | --- | --- |
| Go to all teams | Menu **All teams** | The LoomWatch brand |
| Organize / Undo organize | Menu items | The view bar |
| Open the full trace | Menu **Full trace**; the receipt's **See every event**; the answer's **Full trace** link | **Full trace** in the run's heading, on every run that has started |
| Show the YAML | Menu **View as YAML** | **Show YAML** in the team switcher, with the file's other actions |
| Run the routine now | Menu **Run routine now** | **Run now** on the schedule's panel in Build, and in the composer's note on a new run (different screens) |
| Save the team | The Build heading's **Save**; the Memory panel's **Save team** | **Save** in the team chip, on every screen |
| Read the file again | **Reload from disk** and **Discard** shown together (both reload) | **Discard** (asks first) with changes, **Reload from disk** without |
| Open Run history | The request's **Run history ↓**; the composer's clock button | Menu **Run history**. The drawer moved out of the composer, which Build hides, so the menu item was blank on Build until now |
| Open Memory | The composer's **Memory** chip | Menu **Team memory** |
| Go back to Build | Two **Edit team** buttons on a new run; the replay bar's **Clear** | The **Build** tab |
| Go back to the answer | **Back to output** in the tab bar | The **Run** tab |
| Open the review | The verdict badge; "N more to check" | **Review output** in the run's heading. The verdict is a status |
| See what an agent received | The handoff arrow between stages | **What this agent received** on the agent's card. The arrow only shows the order |
| Select a helper's stage | The receipt's **Show this helper's work** on lines about a helper alone | The stage card just below. Lines with a record still open it |
| Focus the request box | **Request a change** / **Write your request** under the answer | The box itself |
| Tell you a run waits | An Attention toast during a run | The answer box, and the header's needs-you chip, which still counts it |
| Answer a waiting run | The tray's **Looks good** / **Allow** for the run on screen | The run's own answer box and permission card. Its ticket says "On this screen: answer it below." Tickets for other runs keep their buttons |
| Zoom | **−**, **+** and **Fit view** beside the Story · Team · Trace dial | The dial. **Story** now frames the whole team, capped at Story zoom; the wheel, pinch and ⌘− / ⌘+ still zoom |
| Remove a skill, tool, folder or file card | The card's own **×** | The card's panel (**Remove**) and the Delete key, as for an agent card |
| Add a folder or file | The add panel's **Add folder…** / **Add file…** | The agent panel's, which also connect it. The add panel lists the team's folders and files to drag onto other agents |
| Open Connections | **Connect Notion…** links in the Notion settings and under the answer | Menu **Connections…**. Those lines now say where to go |
| Start a run | Ask's **Run this team now** suggestion | **Run team**. The suggestion became "Suggest a folder, file or skill each agent should have" |
| Ask LoomWatch, on Home | The header's **Ask** button, and the Describe-the-job box while the panel is open | **Describe the job** while Ask is closed, the panel's own input while it is open |
| Preview the next run | The **Preview next run** card, always hidden by CSS on Build | **Run team** (the dead card is deleted) |

**Kept on purpose, because they do different things:**
- **Run tab** returns to the last run; **Run team** always opens a blank request.
- **New run**, **Retry** and **Follow up**: a blank request, the same request again, and a
  continuation of the answer.
- **Copy receipt** copies the receipt (renamed from "Copy as Markdown" so it no longer reads like
  the answer's copy). **Copy team output** copies the answer; **Save as Markdown** writes it to a
  file.
- **What was recorded** (renamed from "All activity", whose panel is titled Provenance) audits what
  the record captured, category by category. **Full trace** draws the run on the canvas.
- **What this agent received** shows what the agent was given. **N sources** shows what it
  fetched during the run.
- **Allow from now on** on a receipt line, and the agent panel's switches, are on different screens.

## Consequences

- The menu holds five items: Run history, Team memory, Connections…, Getting started guide and Send
  feedback….
- Connections is one click further from a Notion problem: the line names the menu instead of
  linking. The browser still warns before leaving unsaved changes.
- The canvas bar has no zoom buttons. Anyone who relied on them uses the wheel, pinch, ⌘− / ⌘+, or
  the dial.
- New tests pin each single control: the menu's items, the switcher's Discard/Reload, the bar, the
  capability card, the receipt, the tray's on-screen ticket, the composer, the run's heading,
  Memory, the add panel and Home.
- Not covered: the CSS for `.build-outcome` stays in three stylesheets, unused.
