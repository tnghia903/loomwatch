# 0037 — LoomWatch decides what agents may do without asking

- **Date:** 2026-10-02
- **Status:** Accepted. Daemon: `crates/loomwatch-backend/src/permissions.rs` (new: the policy),
  `acp.rs` (`ProcessSpec::permissions`, `ensure_ask_first`, `build_client_response`),
  `config.rs` (`AgentAllow`), `workspace.rs` (an editing agent's own folder), `lib.rs` and
  `team_bus.rs` (the policy for every run agent and helper); `schemas/team.schema.yaml`
  (`agents[].allow`). UI: `ui/src/components/canvas/AgentPermissions.tsx`, `Inspector.tsx`,
  `BuildInspector.tsx`, `ui/src/lib/team-file/{types,allow,templates,useTeamDocument}.ts`,
  `ui/src/lib/library/{roles,createAgent,types}.ts`, `ui/src/lib/story/receipt.ts`,
  `ui/src/components/run/{RunReceipt,DeliveryLane}.tsx`, `ui/src/components/Workspace.tsx`. Docs:
  `docs/TEAM_CONFIG.md`, `README.md`.
- **Amends:** the rule ADRs 0010, 0029 and 0033 relied on, that every permission prompt is refused
  and the app's own settings grant everything else. Prompts are now answered by a policy.
  ADR 0029's Claude settings grants for connected knowledge and tools stay as they are.
- **Amended 2026-10-03:** decision 3 now holds for Codex. In run 6ebcd025 a Codex Fact-checker was
  refused its own team's `roster`, and Codex reported "user cancelled MCP tool call". ACP's
  `session/request_permission` carries a tool call *update*, and Codex's names only the call:
  `{toolCallId, kind: execute, status}`. The title and input came earlier, in the `tool_call` with the
  same id, so no title shape matched and the prompt was judged as a command. `acp.rs` now keeps
  each in-flight call's title, kind, input, locations and `_meta` (`OpenToolCalls`) and fills in what
  a prompt leaves out before deciding. It also matches Codex's own shapes, `mcp.<server>.<tool>`
  and `rawInput: {server, tool}`, but only on a call Codex marks `is_mcp_tool_call` or
  `is_mcp_tool_approval`. The archive still records the prompt exactly as the app sent it.

## Context

An AI app asks before it acts only when its own settings say to, and `LoomWatch` cannot ask the
operator in the middle of a run, so it refused every request. What an agent could do therefore
depended on each app's own settings, and those differ by app and by machine:

- **The operator's machine hid the problem.** Their Claude Code runs in `auto` mode, so it rarely
  asked, and agents did things `LoomWatch` neither saw nor allowed.
- **A friend on default settings was refused.** A researcher on a fresh Claude Code asked to
  search the web, was refused, and answered from memory. The run said only "asked permission for
  Web search, and it was refused".
- **No app agreed with another.** A probe on 2026-10-02 (`session/new`, no prompt) showed Claude
  Code starting in `auto`, Codex in `agent` ("only ask for actions detected as potentially
  unsafe"), and Gemini CLI in `default`.
- **Team Bus calls could be refused too.** An app in an asking mode asks before calling an MCP
  tool. A refused `dispatch` or `handoff` breaks the team, so that was latent on default settings.

The operator asked for the control to live in `LoomWatch`, not in each app.

## Decision

1. **One policy answers every run agent's requests.** `PermissionPolicy` (`permissions.rs`) is built
   for each run agent and Team Bus helper from its switches, its working folder and what was
   delivered to it. It is part of `ProcessSpec`, so a respawned stage keeps it. Ask (ADR 0033)
   and model discovery keep `None`, which refuses everything as before.
2. **The app is put in its ask-first mode.** After `session/new`, and again after `session/load`,
   the session is switched with `session/set_mode` to the first mode in
   `["default", "read-only"]` that it advertises. An app with no such mode, or one that refuses it,
   is recorded as `permission_mode_unavailable`, and the run goes on. OpenCode never asks, and the
   panel says so.
3. **Always approved:** the Team Bus (`loomwatch-team-bus`) and every connected tool's server, by the
   tool-title shapes ADR 0033 already matches. Also approved: a `read` or `search` whose paths all
   lie in the agent's folder or in a connected knowledge folder or file. These were already chosen
   when the operator connected them.
4. **Three switches, all off by default** (`agents[].allow`):
   - `web` allows the `fetch` kind.
   - `commands` allows `execute`.
   - `edits` allows `edit` only when every location resolves inside the agent's folder, with
     symlinks followed and `..` folded. Edits under `.claude`, `.agents`, `.codex`, `.gemini`,
     `.opencode`, `.git` and `.loomwatch` are refused, because changing those could grant the agent
     more on its next session.
   - A request with no kind, or a kind no switch covers (`delete`, `move`, `other`), is declined.
5. **Only the one-time option is chosen.** `allow_always` would be written into the app's own
   settings and outlive the switch.
6. **An editing agent never works beside its team file.** If `allow.edits` is on and the declared
   `cwd` holds the team file (`cwd: .`, every template's default), the agent gets its managed folder
   (`.loomwatch/<team>/<agent>/`) as memory and connected capabilities already do. A folder the
   operator chose stays the agent's.
7. **Defaults follow the job.** The built-in Researcher job, and the templates' researchers, start
   with `web: true`. A researcher that cannot search can only guess. Nothing else starts switched
   on.
8. **The receipt explains a refusal and offers the fix.** Refused requests become one line per
   agent per switch ("wasn't allowed to search the web (asked 3 times)"). Each line has
   **Allow from now on**, which switches it on and saves the team, plus one check line saying why
   `LoomWatch` says no. An edit refused while `edits` is already on reads "outside its own folder"
   and offers nothing.

## Consequences

- On the operator's machine, agents that used to act silently in `auto` mode now ask, and only what
  their switches allow goes through. The app's own allow rules, such as the daily-news team's
  `.claude/settings.json` and ADR 0029's grants, still apply, because the app checks them before it
  asks.
- Saved jobs (ADR 0030) do not carry `allow` yet. A job saved from an agent with switches on is
  placed with them off. That is a follow-up.
- Verified live against Claude Code on 2026-10-02 (`claude-agent-acp`, one prompt, no `LoomWatch`
  run). The session started in `auto` from the operator's settings and accepted `session/set_mode`
  `default`. It then asked before its web search, as `kind: fetch` with `allow_once`,
  `allow_always` and `reject_once` offered. Approving once let the search complete. Codex
  (`codex-acp` 2.1.1, in `read-only`) labels every MCP tool call `execute` and asks before each one,
  and its web search arrived as `search` without asking (run 6ebcd025). So in Codex a tool from a
  server `LoomWatch` did not connect falls under `commands`, not under its own switch. How Gemini's
  own tools map onto ACP kinds is not verified yet. Gemini's web search may arrive as `search`,
  which counts as a read and is declined outside the agent's folder.
- Asking the operator live, a run that pauses with Allow and Deny, can now be built on this one
  decision point. It is not part of this ADR.
