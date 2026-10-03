# 0042 — Every source an agent uses is on the canvas, and connecting one never moves the agent

- **Date:** 2026-10-03
- **Status:** Accepted.
  - Daemon:
    - `crates/loomwatch-backend/src/workspace.rs`: `materialise` starts an agent in the workspace
      only when its declared folder holds the team file; `Workspace::root`.
    - `delivery.rs`: `Delivery::copies`; `prepare_for` names a long file's full text by its path
      when the agent works elsewhere.
    - `chosen_knowledge.rs`: `relocate_copy_note`.
    - `permissions.rs`: the workspace is readable wherever the agent works.
    - `composer.rs`: `CapabilityNode::path`.
  - UI:
    - `ui/src/lib/composer-layout/types.ts`: `sourceCardId`, `cardId`, `capabilityForCard`,
      `uniqueLabel`; `teamFileKind` and `capabilityIsCard` know folder and file cards.
    - `ui/src/components/Workspace.tsx`: `teamFileCards`, `keepUnusedCard`, `placeSources`,
      `chosenItem`.
    - `ui/src/components/canvas/{AddSource,BuildNodeCard,CapabilityInspector,
      BuildResourceInspector,AgentWorkFolder,AgentContext,Inspector}.tsx`.
    - `ui/src/components/library/ComponentPalette.tsx`.
    - `ui/src/lib/knowledge/chosen.ts`, `ui/src/lib/team-file/workFolder.ts`.
  - Docs: `docs/TEAM_CONFIG.md`.
- **Amends:**
  - [ADR 0012](0012-capability-delivery.md) decision 4: an agent with capabilities ran in the
    workspace.
  - [ADR 0036](0036-knowledge-is-chosen-not-discovered.md) decision 3: the canvas never wrote
    knowledge.
  - [ADR 0039](0039-agent-panel-drops-process.md) decision 3: the panel said a connected agent
    gets "its own folder".

## Context

An operator configuring an agent asked five questions:

1. How do I use Notion as context?
2. Should the folders and connections each agent uses show on the canvas?
3. What is the team's folder?
4. What if one agent works in a different folder from the others?
5. Isn't it confusing to have a Context folder and a Works in folder?

Reading the code behind the panel found a defect under questions 4 and 5. `materialise` moved any
agent with something connected into `<team dir>/.loomwatch/<team>/<agent>/`, whatever its
`spawn.cwd` said. The chosen folder supplied only its `.claude/settings.json`, and no read grant.
So an agent set to work in `sutd-final-project` silently stopped working there the moment a
reference folder, a file or a skill was added in its Context. Afterwards the panel said "Its own
folder", but nothing warned before the click. An agent could not work on a project and also read a
second folder.

The move existed so that skills could sit in the harness's own skill folder. That turned out
unnecessary for what LoomWatch delivers. A required skill's prompt already says "read
`<absolute path>/SKILL.md` in full", and since ADR 0037 every app asks LoomWatch before reading
outside its folder. The two other things the workspace held were the Brief as `CLAUDE.md`, which
also reaches the agent in its packet, and the full texts of long added files, whose prompt note
named them as `knowledge/<file>` "in your working folder".

On the canvas, the operator could not see what each agent used:

- Cards came only from the `.layout.json` sidecar. A skill named in the team file with no sidecar
  card was invisible ("Add its card to see these connections").
- A folder or file chosen in Context never had a card at all.
- Sharing one folder between agents meant adding it in each agent's panel.

## Decision

1. **Only the team's own folder is ever swapped for the workspace.** An agent whose declared
   folder holds its team file (`.`, `..`) still starts in the workspace when it has something
   connected, may edit, or keeps its Brief in its app's memory file. An agent in a folder the
   operator chose starts there, however much is connected.
   - The workspace still holds its copies.
   - The prompt names each copy by its full path. For a skill that was already true; a long file's
     note is rewritten from `knowledge/<file> in your working folder` to the copy's absolute path.
   - `Delivery::copies` makes the workspace readable in the permission policy, so the app's request
     to read a copy is approved.
   - Nothing is written into the chosen folder. The Brief reaches the agent in its packet only, and
     no settings file is written to a workspace the app never opens.
2. **Every source an agent uses is a card.** The canvas draws a card for each skill, tool, folder
   and file named in an agent's `capabilities` that the sidecar has no card for, like the memory
   cards of ADR 0016. It is placed under the first agent that uses it, and the sidecar gets it on
   the first drag.
3. **A folder or file is one card per path**, keyed `knowledge@<path>`, however each agent labels
   it. It has a line from every agent that reads it. The sidecar card gains an optional `path`
   (additive, so the version stays 2); the daemon refuses a `path` on any card that is not
   knowledge, or on a memory card.
4. **Sharing is drawing a line.** A line from an agent to a folder or file card adds
   `{kind: knowledge, name, path}` to that agent, with a label it does not already use. Removing
   the line removes the entry matched by path. Removing the card disconnects every agent. The
   card's panel has the same **Use with agents** picker as a skill's, and says what each agent gets
   and that it is read only.
5. **A card outlives its last line.** When the last agent is disconnected from a card drawn from
   the team file, the card is saved in the sidecar where it is, so it can be connected again.
6. **The add panel adds sources.** Under Knowledge, **Add folder…** and **Add file…** put a card on
   the canvas that no agent reads yet. The agent panel's own buttons still connect what they add to
   that agent at once.
7. **The panel says which folder is which.**
   - Works in names the team's folder's real path, and says an agent there can read your other
     teams.
   - A chosen folder is called the agent's project.
   - Connected folders and files are labelled "read only".
   - The "Work in this folder" Brief switch only shows where it decides something: an agent in the
     team's folder.

## Consequences

- Teams whose agents already had a chosen folder and something connected now run in that folder.
  That is the intended behaviour, but the run changes: the agent's relative paths, `git` and
  commands now act on the project rather than on `.loomwatch/`.
- An agent in a chosen folder no longer gets its Brief as a native memory file, so a long session
  can compact it away (docs/TEAM_MEMORY.md channel 2). Writing `CLAUDE.md` into someone's project
  would be worse.
- On Claude Code a skill in a chosen-folder agent is not discovered as a native skill; it is read by
  path, as the prompt already instructed. If an app ever refuses reads outside its folder without
  asking, that agent's skills would fail to open, and the run's "opened the skill" evidence would
  show it.
- `teamFileCards` places a card under its first agent until it is dragged, so it follows that agent
  around. Organize lays it out like any other card.
- Still open:
  - A Notion page as a source. Notion is connected for delivery only (ADR 0038), so a page would
    need its own fetch at run start.
  - A preview of what a folder or file card hands its agents. That needs an endpoint limited to
    paths the team names, because `GET /api/folders` returns names and never contents.
