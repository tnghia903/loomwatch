# 0029 — A wired knowledge source or tool is delivered to the agent

- **Date:** 2026-10-01
- **Status:** Accepted. Daemon: `crates/loomwatch-backend/src/delivery.rs` (new),
  `capabilities.rs` (`knowledge_snapshot`, `tool_definitions_for`), `config.rs` (`CapabilityKind`),
  `workspace.rs` (`materialise`, `prepare_root`), `acp.rs` (`ProcessSpec::tools`,
  `wired_tool_servers`), `memory.rs` (`ComposedPrompt::with_delivery`, two section kinds), `lib.rs`
  (`compose_for`, `wired_capabilities`, the run paths) and `team_bus.rs`; `schemas/team.schema.yaml`.
  UI: `ui/src/components/Workspace.tsx`, `components/canvas/{CapabilityInspector,BuildNodeCard}.tsx`,
  `lib/composer-layout/types.ts`, `lib/team-file/types.ts`, `lib/watch/events.ts` and
  `lib/runs/capabilityEvidence.ts`.
- **Amends:** [`0012-capability-delivery.md`](0012-capability-delivery.md) decision 1, which kept
  tools and knowledge sources out of the team file "because each needs a delivery contract this ADR
  does not write — an MCP grant and a mounted source respectively". This ADR writes both.
- **Does amend:** `schemas/team.schema.yaml` — `$defs/Capability.kind` gains `knowledge` and `tool`.

## Context

ADR 0012 was written because a wire on the canvas that did nothing read as a bug, and it was filed
as one. It fixed that for skills and left tools and knowledge sources as "planned intent". The same
bug came back for those.

An operator wired the `loomwatch project` knowledge source to the Research agent in
`loomwatch-market-research` and asked whether the knowledge was being fed into the run. It was not:

1. The edge lived only in `loomwatch-market-research.layout.json`. Nothing on the run path reads
   that sidecar; outside `composer.rs`, only `api.rs` names `layout_path`, to serve the canvas.
2. The team file had no way to say it. `CapabilityKind` had one member, `Skill`.
3. The archived `prompt_sections` record for the 2026-09-17 run shows Research was given exactly two
   sections, its role and the task. The agent did read `../README.md` and `../docs/ARCHITECTURE.md`,
   but only because an agent with no capabilities keeps its declared `cwd`, `teams/`, which happens
   to sit inside the repository. A teams folder anywhere else would have shown it nothing.

The inspector had just gained a **Contents** section (the same day) showing what a knowledge source
holds. That made the gap plainer: what the operator could see was what they reasonably expected the
agent to get.

Two facts shaped the contract:

- **Every harness permission prompt is refused** (`acp.rs`, `session/request_permission`). So a
  folder named in a prompt, or an MCP server handed to Claude Code, is unusable unless the
  workspace's own permission file already allows it.
- **ACP already carries MCP servers.** `session/new` and `session/load` take `mcpServers`, and the
  Team Bus has been passed that way since ADR 0002. ACP requires every agent to accept stdio servers,
  and HTTP or SSE when it advertises them. Delivering a tool this way works on every ACP harness,
  not just on the one whose config file lists the server.

## Decisions

1. **Knowledge and tools are team-file capabilities.** `agents[].capabilities[].kind` is `skill`,
   `knowledge` or `tool`. As with skills (ADR 0012 decision 2), connecting one on the canvas is a
   team-file edit that waits for an explicit save, and the sidecar keeps only positions. Team memory
   is not a capability. It stays on `memory.inherits` (ADR 0016), and a `knowledge` entry naming a
   memory source fails the run, saying so.

2. **A knowledge source is delivered as its snapshot.** Before the harness starts, the daemon reads
   the source with `capabilities::knowledge_snapshot`. This is the same function behind the
   inspector's Contents, so what the operator sees is exactly what the agent gets. For a project
   folder, the snapshot is its top-level listing and README excerpt; for an OpenCode project, its
   recent session titles. The prompt carries it under `## Knowledge: <name>`, framed as source
   material and not as instructions, which is the trust boundary the context packet already keeps.
   The record carries its fingerprint.

3. **A folder source is also a read grant, written where LoomWatch knows how.** Wiring a folder is
   the operator saying the agent may read it. On Claude Code, LoomWatch merges two things into the
   workspace's `.claude/settings.json`, which ADR 0012 decision 3 carries over from the declared
   cwd: `permissions.additionalDirectories` and a `Read(//<folder>/**)` allow rule. Only that is
   added, nothing is replaced, and the operator's own `deny` still wins because Claude Code
   evaluates deny first. On other apps the folder is named in the prompt, and the app's own policy
   decides. The record states which case applied (`readAccess: granted | harnessPolicy`), so the
   difference is never silent.

4. **A tool is the operator's own MCP server, passed through ACP.**
   - **Lookup.** The daemon reads the server definition from the config the Library found it in:
     Claude Code's `mcpServers`, Codex's `[mcp_servers.<name>]` (now parsed with the `toml` crate),
     or OpenCode's `mcp`. When the agent's own app has a copy, that one is preferred.
   - **Conversion.** The definition is converted to ACP's `McpServer` shape and added to
     `mcpServers` on `session/new`, beside the Team Bus.
   - **Respawns.** It rides on `ProcessSpec`, not on the prompt, so a parked stage reopened with
     `session/load` gets the same servers it started with.

5. **Anything that cannot be delivered fails the run up front.** ADR 0012 decision 5, extended. The
   run fails, naming the capability and what to change, when:
   - the source or tool is not found;
   - a memory source is wired as knowledge;
   - the source has nothing readable;
   - the agent's knowledge exceeds 64 KiB, rather than being shortened;
   - the server is disabled in its own config;
   - the server needs an environment variable the daemon lacks;
   - the server uses a setting ACP cannot carry: a Codex `cwd`, or `enabled_tools`/`disabled_tools`.
     Delivering it without that setting would hand the agent something its owner did not configure;
   - the server takes the Team Bus's name, or two wired tools are the same server;
   - the transport is one the harness did not advertise. This is checked after `initialize` and
     before `session/new`, so no session is ever created without its tools.

6. **Secrets stay inside the process boundary.** Environment and header values are resolved from the
   operator's config and the daemon's environment: Claude Code's `${VAR}` and `${VAR:-default}`,
   OpenCode's `{env:VAR}`, and Codex's `env_vars`, `bearer_token_env_var` and `env_http_headers`.
   They travel only in the `session/new` request to the local harness process. `DeliveredTool`
   serialises and debug-prints names only. The archive, the REST API and the UI see the server,
   transport, config path and env/header **names**. The `session/new` request is not archived, which
   was already true for the Team Bus token. Verified end to end: a token value never appears in
   `run_events` or `GET /api/runs/{id}`.

7. **A wired tool is allowed on Claude Code.** For the same reason as decision 3, the workspace
   settings gain `mcp__<server>`, which allows every tool of exactly that server. Other apps decide
   for themselves, and the record says `permission: harnessPolicy`. Because the managed settings
   file now carries grants, it is managed like the skill trees. When the declared cwd has no
   settings file, any earlier run's file is removed, so a grant never outlives the wiring that
   justified it, including across a harness switch.

8. **The prompt names what was delivered and does not command it.** `## Capabilities wired for you`
   lists every kind. A skills-only agent keeps its old sentence byte for byte. Each tool gets a
   `## Tool: <name>` section naming the server, and on Claude Code the `mcp__<server>__<tool>` names
   it will see. Like a skill, its use is the model's call within the harness's permissions. An agent
   that wires no knowledge and no tools gets exactly the prompt it got before.

9. **Old canvas wiring is surfaced, not silently promoted.** A sidecar edge to a skill, tool or
   non-memory knowledge card is "legacy wiring" when the agent's team-file entry does not name it.
   It was drawn before its kind was delivered. The canvas says how many such connections are "drawn
   but not delivered", and **Deliver on the next run** writes them into the team file for the
   operator to save. Drawing one again also works. It used to be refused as "That agent already
   reaches this capability", because the refusal counted sidecar-only edges.

## Consequences

- An agent wired only to knowledge or tools now runs in a managed workspace
  (`.loomwatch/<team>/<agent>/`) rather than its declared `cwd`, as ADR 0012 decision 4 already
  meant by opting in. Research in `loomwatch-market-research` loses its accidental view of the
  repository and gains an explicit one. No skill tree is prepared for an agent that wires no skill.
- Every card is matched to the team file by **kind and name**. A tool and a skill can share a name,
  and the old name-only matching would have wired or removed the wrong one.
- Skill receipts (`capabilityEvidence`) count only `kind: skill` entries. A knowledge source or tool
  has no `SKILL.md` to open, and would otherwise read as "never opened".
- The WebSocket schema gains two section kinds and two optional `prompt_sections` keys
  (`docs/WEBSOCKET_SCHEMA.md`, 2026-10-01). Both are additive, and a run that wired neither records
  exactly what it did before.
- Not covered: remote knowledge (a Notion page, a URL) has no snapshot and is not modelled. Per-tool
  filtering is refused rather than approximated. Read grants and tool allows are written only for
  Claude Code, the one app whose per-workspace permission file LoomWatch knows. A follow-up can add
  others once their formats are verified on a machine, not guessed.
