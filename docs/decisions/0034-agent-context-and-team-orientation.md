# 0034 — The agent panel shows its Context, and every agent is told its place in the team

- **Date:** 2026-10-02
- **Status:** Accepted. Daemon: `crates/loomwatch-backend/src/orientation.rs` (new), `lib.rs`
  (`NodeTask::place`, `compose_prompt`, the team-mode and pipeline call sites), `team_bus.rs`
  (the delegated-helper call site), `memory.rs` (`PromptSectionKind::Team`, insertion points).
  UI: `ui/src/components/canvas/{AgentContext,Inspector,BuildInspector}.tsx`,
  `ui/src/lib/team-file/agentPlace.ts`, `ui/src/components/Workspace.tsx` (the inspector's props),
  `ui/src/lib/watch/events.ts`, `ui/src/styles/app.css`.
- **Amends:** `docs/UX_REDESIGN.md` §5.4 — the inspector's middle zone is CONTEXT, not BEHAVIOUR.
  `docs/WEBSOCKET_SCHEMA.md` — `prompt_sections` gains the section kind `team` (additive).

## Context

The agent inspector's BEHAVIOUR zone had five switches. An operator reviewing it called it a
useless section, and checking each switch against the code agreed:

| Switch | What it did |
|---|---|
| Starts the team | Set `entrypoint`. Shaped like a checkbox, but it disabled itself once on and could not be unticked. |
| Produces the team output | Set `responder`. Three other controls already do this: the agent → Output wire, the Output editor's "Produced by", and "Final response owner". In team mode it could never be clicked. |
| Can ask other agents for help | `allowRecruiting`. **In team mode it did nothing**: `skill_routing::bus_tools` returns `ask: team \|\| allow_recruiting`, and `team_bus::refuse_by_mode` returns before reading it. In pipeline mode it works, but its hint read "Off when steps run in order" while the box was ticked. |
| Reads the team Brief | `memory.brief`. Disabled for every team without a Brief, which is every new team. |
| Brief in its own memory file | `memory.deliverAs`, explained in implementation words ("packet", "compaction"). |

The panel also never said what the agent is *given*. Connected skills, knowledge and tools could
only be found by following lines on the canvas.

The prompt side had the matching gap. An agent learned who its teammates were only by calling the
Team Bus `roster` tool. Nothing told the agent whose reply became the team's answer that it was
writing for the operator, so a final stage often ended with notes about its work instead of the
work. Nothing told a pipeline stage that its successor would see only its handover. These were
canvas facts the operator could see and the agent could not. Context-engineering practice for
multi-agent systems says each agent should be told its objective, where its output goes, and its
boundaries. People who never write a prompt should get that by default, not by knowing to ask.

## Decisions

1. **CONTEXT replaces BEHAVIOUR.** The zone says what the agent is given, in the order it matters:
   - **its place in the team**, worded as what the agent is told (decision 4), with **Make this
     the starting agent** where that is legal;
   - **Can bring in helpers**, offered **only in pipeline mode**, the one mode where it decides
     anything, with corrected wording;
   - **the team Brief**, a switch only when the team has one, and otherwise one line saying how
     to add one;
   - **everything connected**: each skill, knowledge source and tool, removable by kind and
     name, plus read-only rows for inherited team memory.

   The same component appears in the short Build panel that most operators see first.
   *Produces the team output* is removed. *Starts the team* becomes an action.

2. **`deliverAs` moves into PROCESS, next to the folder it decides, and is shown only when it
   decides something.** That means an agent with a Brief and nothing connected. With anything
   connected, the agent already works in its own folder (ADR 0012 decision 4, ADR 0029). The
   Working folder hint now says so, instead of offering a choice the run would ignore. The control
   is worded as the decision the operator actually makes: **Work in this folder**. On keeps the
   declared folder; off keeps the Brief compaction-proof in the AI app's memory file. The team
   file is unchanged: `packet-only` and `native-file`, and a per-agent key is written only when it
   differs from the team default.

3. **"Make this the starting agent" is offered only where the result is a valid team.** In team
   mode, any agent can lead. In pipeline mode, `pipeline_order` refuses an entrypoint with an
   incoming edge, so only an agent nothing hands work to is offered it.

4. **Every agent on a team of two or more is told its place.** A new prompt section,
   `## Your place in the team` (kind `team`), sits directly under `## Your assigned role`.
   `orientation.rs` writes it from the team file and the run's own order, at the three call sites
   that compose a prompt:
   - **Team-mode lead:** it receives the request first, and its reply is the team's final answer.
     It also gets its teammates (name, id, first line of role, cut at 140 characters), but only
     when its harness is offered the Team Bus tools. Listing agents it has no way to reach would
     be an instruction it cannot follow.
   - **Pipeline stage:** step *k* of *n*, then who comes before it and who comes after, both from
     the configured edges. A join names every branch, and a review stop is named as the operator.
     A stage with successors is told that its handover is all they receive. The responder is told
     its reply is the final answer.
   - **Delegated helper:** who brought it in, and that the task is one part of a larger piece of
     work. Nothing is said about where its reply goes. `ask` returns it to the caller, but
     `dispatch` and `handoff` run in the background, and the helper cannot tell which it is.

   The final-answer line is the same everywhere: *make it the finished result itself, not a report
   on how you produced it.*

5. **Facts only, and nothing for a team of one.** Every sentence is read off the team file or
   the run's order, never inferred. A single-agent team gets no section, so its prompt stays
   byte-for-byte what it was. The memory phase-1 guarantee — a team without `memory:` gets exactly
   the prompt it always got — still holds for that case and is still tested
   (`a_team_without_memory_gets_exactly_the_prompt_it_got_before`).

6. **The panel mirrors the prompt.** `agentPlace.ts` derives the panel's sentence from the same
   facts, and the panel says "The agent is told this at the start of every run." Like
   "what you see in Contents is what the agent gets" (ADR 0029), the operator reads what the agent
   reads.

## Consequences

- Every multi-agent team's prompts gain a section. The record says so: `prompt_sections` carries
  `team`, and the UI's `PromptSectionKind` gained it in the same change.
  `ComposedPrompt::with_delivery` and `with_required_skills` insert after it, so skills, knowledge
  and tools still follow the capabilities list. The prompt text is still exactly the joined
  sections (tested in `delivery.rs`).
- `allowRecruiting` is unchanged in the team file and in behaviour. Only its control moved, and in
  team mode it is no longer shown.
- `InspectorProps` loses `isEntrypoint`, `isResponder` and `onPromoteResponder`, and gains
  `place`, `inheritedMemory` and `onRemoveCapability`. Choosing the responder stays where it
  already was: the Output wire, the Output editor and Final response owner.
- Not covered: connecting a folder or file the Library did not discover ("Add folder…",
  "Add file…") needs a daemon-side knowledge source of its own. It is the next step, and the
  CONTEXT zone is where it will appear.
