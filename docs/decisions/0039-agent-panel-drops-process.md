# 0039 — The agent panel drops Process; the zoomed-in card says what an agent may do

- **Date:** 2026-10-03
- **Status:** Accepted. UI only: `ui/src/components/canvas/{Inspector,BuildInspector,AgentWorkFolder,
  AgentPermissions,FolderPicker,BuildNodeCard}.tsx`, `ui/src/lib/team-file/{workFolder,allow}.ts`,
  `ui/src/lib/story/depth.ts`, `ui/src/styles/{app,loom}.css`. No daemon or schema change.
- **Amends:** `docs/UX_REDESIGN.md` §5.4 (the PROCESS zone) and
  [ADR 0023](0023-the-loom-layer-one-surface-three-depths.md) (what the Trace depth adds).

## Context

The full agent panel ended in a collapsed **Process** zone: `cmd`, `args`, `env` and a
**Working folder** text box holding `.`, "relative to the team file". The operator called it
unnecessary, and three of its four rows are: the command and arguments follow from the AI app
chosen in Build, the environment names are for whoever wrote the YAML, and all three are
read-only. Show YAML already shows them.

The fourth row is not unnecessary. The folder an agent starts in is where it may read files, and,
with ADR 0037's switches on, where it edits files and runs commands. A folder the operator chooses
stays the agent's (ADR 0037 decision 6), so it is how a team works on a real project. It was
hidden two clicks deep, as a path to type.

The card's Trace depth (ADR 0023) listed `id`, `model`, `command`, `folder` and `skills`: the
same Process facts again, with `skills none` on almost every card. What the card did not say is
what changes a run's outcome and is otherwise invisible on the canvas: what the agent may do
without asking, and what it is given.

## Decision

1. **Process is removed** from the agent panel. The command, arguments and environment stay in
   the team file and in Show YAML; the id stays in the panel's header.
2. **WORKS IN** takes the folder, in both the short Build panel and the full one, between
   CONTEXT and ALLOWED WITHOUT ASKING, because the switches below it act in that folder. It names
   the folder ("The team's folder", or the chosen folder's name and path) and **Choose folder…**
   opens the knowledge folder picker, retitled, storing the absolute path. **Use the team's
   folder** puts `.` back, and also fixes a missing `cwd`.
3. **The panel says when LoomWatch overrides the folder**, mirroring `workspace::materialise`
   for the cases the panel can see for certain: anything connected ("Its own folder", the chosen
   one named as unused, no choice offered), and an editing agent whose folder holds the team file
   ("never changes your team files", choice offered). The third case, a Brief kept in the app's
   memory file, stays with the **Work in this folder** switch, which moves under WORKS IN.
4. **Trace depth shows what the panel would tell**, in the sans face rather than mono:
   **Model** (with its thinking effort), **Allowed** ("Search the web, run commands", "Reading
   only", or "Anything: OpenCode doesn't ask"), **Given** (everything connected, a skill or tool
   saying which), **Works in** (only a chosen folder that is actually used) and, during a run,
   **Events**.

## Consequences

- A chosen folder is stored as an absolute path, so a team file that uses one names a folder on
  this computer, as knowledge folders already do (ADR 0035).
- `ownFolderReason` duplicates two of the daemon's rules. If `workspace::materialise` changes
  when an agent gets its own folder, `ui/src/lib/team-file/workFolder.ts` must change with it.
- A Brief kept in the app's memory file also moves the agent, but the panel only says so through
  the Work in this folder switch, so WORKS IN can name a folder the agent does not start in.
