# WebSocket message schema

Revision 1 · 2026-09-06 · **frozen per [ARCHITECTURE.md §7](ARCHITECTURE.md#7-build-phases)**

This document freezes the message schema `loomwatchd` pushes to the web UI over
WebSocket at the end of Phase 03, incorporating the TNG-42 Phase 03 review (its wire
findings landed as TNG-45 and TNG-46). Phase 04 (Canvas) and Phase 05 (Watch & alert)
build against it; any change requires a new ADR under `docs/decisions/`.

**Implemented by the local archive viewer.** `/api/session/stream` replays and follows
PostgreSQL evidence using an exclusive `afterSeq` cursor. Its text frames preserve the
Phase-02 contract unchanged: **a WebSocket message is one JSON-serialized `RunEvent`**.
The browser catches up and recovers gaps through paginated REST evidence. See
[WATCH.md](WATCH.md) for endpoint parameters and the loopback-only access boundary.
These legacy session endpoints do not implement the proposed immutable run API.

The machine-readable contract is
[`schemas/team.schema.yaml`](../schemas/team.schema.yaml) — `$defs.RunEvent` plus the
per-kind payload `$defs` (`MessagePayload`, `ToolCallPayload`, `ToolUpdatePayload`,
`TurnEndPayload`, `UsagePayload`, `ProcessPayload`); backend tests validate every
emitted event against it. This document is the human-readable companion, fixing the
payload shapes the JSON Schema leaves open and the Team Bus semantics on top.

## 1. Frames

- One WebSocket text frame carries **one JSON-serialized `RunEvent`** (camelCase) —
  the same serialization the archive stores and `loomwatchd show` prints. Live frames
  and replayed history are indistinguishable.
- The server pushes frames in **`seq` order**. `seq` is dense per session, starts at
  0, and is the sole replay order; `ts` is descriptive only. A gap means dropped
  frames — re-sync from the archive (Postgres enforces `UNIQUE(session_id, seq)`).
- **`sessionId` identifies one run, not one agent.** The entrypoint (team mode) or
  first pipeline node (pipeline mode) mints it from its ACP session; every other agent
  in the run — delegated, recruited, or a later pipeline node — appends to that same
  session. `agentId` (a team-config ID) distinguishes contributors.
- Runs started through `POST /api/runs` ([ADR 0008](decisions/0008-run-control-api.md))
  use a LoomWatch-minted `sessionId` equal to the `runId`, chosen before any process
  exists; CLI runs keep the harness-minted id. Raw frames carry each harness's own ACP
  session id either way. No frame field or event kind changes.
- **No run-completion event exists in v1.** A run is over when every observed agent
  has a terminal `process` event (`exited`/`crashed`) and no `dispatch`/`handoff` tool
  call is outstanding. Delegated agents keep appending after the entrypoint's
  `turn_end`; the number of outstanding background delegations is bounded by
  `guards.maxConcurrentDispatches`.

## 2. Envelope

```json
{
  "id": "0b4c9b6e-4ef0-4a2c-9d1b-2f6a8e5c7d01",
  "sessionId": "acp-3f2a…",
  "agentId": "reviewer",
  "seq": 42,
  "ts": "2026-09-06T10:04:01.123456Z",
  "kind": "tool_call",
  "payload": { },
  "raw": { }
}
```

- `id` — UUID v4 minted by LoomWatch; ACP updates carry no ID of their own.
- `ts` — RFC 3339, microseconds, UTC. LoomWatch emits uppercase `T`/`Z`; readers
  accept any RFC 3339 form.
- `raw` — the originating JSON-RPC frame, verbatim. Required for every kind except
  `process`, where it is omitted (LoomWatch-local events).

## 3. Event kinds

`kind` is one of `message`, `thought`, `tool_call`, `tool_update`, `plan`,
`permission`, `session_meta`, `usage`, `turn_end`, `process` (unchanged since Phase
02; Phase 03 added zero kinds).

| kind | payload | produced by |
|---|---|---|
| `message` | `$defs.MessagePayload`: `{role, messageId?, content}` | queued prompt (`role:"user"`, `messageId:null`, raw = the `session/prompt` request) and agent reply chunks (`role:"agent"`) |
| `thought` | same shape, `role:"thought"` | `agent_thought_chunk` |
| `tool_call` | `$defs.ToolCallPayload`: `{callId, title, name?, toolKind?, status?, rawInput?, rawOutput?, content?, locations?}` | ACP `tool_call`; **Team Bus calls (§4)** |
| `tool_update` | `$defs.ToolUpdatePayload` (deltas keyed by `callId`) | ACP `tool_call_update`; **guard rejections (§4.3)** |
| `plan` | ACP plan update verbatim (`sessionUpdate`: `plan`/`plan_update`/`plan_removed`) | plan lifecycle |
| `permission` | request: the `session/request_permission` params (incl. `options`); reply: `{outcome: {outcome, optionId?}}` | permission negotiation — LoomWatch answers `reject_once`, else `reject_always`, else `cancelled`; no targeted harness ever offers `reject_always` (see [ACP_SPINE.md](ACP_SPINE.md), TNG-47) |
| `session_meta` | `{phase, …}` — see below | handshake and anomalies |
| `usage` | `$defs.UsagePayload` — see §4.4 | harness usage updates, archived as evidence |
| `turn_end` | `$defs.TurnEndPayload`: `{stopReason, usage?}`; `stopReason` ∈ `end_turn`/`max_tokens`/`max_turn_requests`/`refusal`/`cancelled` (default `end_turn` if the harness omits it) | one per turn; `usage` is archived as evidence |
| `process` | `$defs.ProcessPayload`: `{phase, pid?, exitCode?, signal?, message?}`; `phase` ∈ `spawned`/`exited`/`crashed` (`stderr` is reserved in the schema, currently unused) | supervisor |

`content` in message/thought events is the ACP ContentBlock, e.g.
`{"type":"text","text":"…"}`. The **last `role:"agent"` message of an agent is its
reply**: pipeline mode feeds it to downstream nodes as their prompt (§5), and `ask`
returns it to the caller (§4). `toolKind` ∈ `read`/`edit`/`delete`/`move`/`search`/
`execute`/`think`/`fetch`/`switch_mode`/`other`; tool `status` ∈ `pending`/
`in_progress`/`completed`/`failed`.

`session_meta` phases: `initialize` and `session_new` (`result` = negotiated
response), `set_config_option` / `set_config_option_skipped` (model routing),
`team_bus_unavailable` (the run has a Team Bus but this harness did not advertise
HTTP MCP — the agent has no bus access), `context_packet` and `prompt_sections`
(team memory — see below), and `unprojected_session_update` (an update that could
not be normalized; `warning` plus the raw update).

`session_meta` phases are an open set by construction — a reader must tolerate a phase it does
not know — so adding one is additive and does **not** unfreeze this schema. Team memory added
two, both archived immediately before the opening prompt they describe:

The `kind` list inside `prompt_sections` is the same kind of open set, and the same rule applies to
it: a reader must tolerate a kind it does not know. It is still extended in **one** change with
`memory::PromptSectionKind` and `ui/src/lib/watch/events.ts`, because a section the daemon records
and the client does not know is a section the packet inspector silently drops. `previous_output`
was added that way in [ADR 0016](decisions/0016-sidecar-v2-followups-and-checkpoints.md).

| Phase | Payload | Why |
|---|---|---|
| `context_packet` | `{heading, chars, budgetChars, sections}` | How much team memory this session was supplied, and the per-section selection rationale. The full text is read back from `GET /api/runs/{id}/context?agent=`; this event is the invalidation hint and the size. |
| `prompt_sections` | `{sections: [{kind, heading, text}]}` | What the `LoomWatch`-composed opening prompt is made of: `role`, `team`, `capabilities`, `memory`, `task`, `stage_results`, `previous_output`, `ask_offer`. Replaces splitting the prompt on literal headings in the client, which silently mis-attributed text as soon as the daemon gained a section (`ui/src/lib/watch/events.ts`). |

No new event *kind* was added, and `run_events` is unchanged. See
[TEAM_MEMORY.md](TEAM_MEMORY.md) and [ADR 0014](decisions/0014-team-memory-brief-and-packets.md).

## 4. Team Bus events

Every bus interaction is archived by the bus itself as one `tool_call` + one
`tool_update` pair on the **calling** agent, in the shared run session. The bus pair
is authoritative; see §4.5 for harness echoes.

- `tool_call.payload`: `{"callId":"<uuid>","title":"Team Bus: <tool>","name":"<tool>",
  "toolKind":"other","status":"in_progress","rawInput":<arguments>}`; `raw` = the MCP
  `tools/call` JSON-RPC request.
- `tool_update.payload`: `{"callId":"<same uuid>","status":"completed"|"failed",
  "rawOutput":<result>}`; on failure `rawOutput` is `{"error":"<reason>"}`. `raw` = the
  JSON-RPC response.

| tool | `rawInput` | `rawOutput` on success |
|---|---|---|
| `roster` | `{}` | array of `{id, name, role, model, allowRecruiting, capabilities:{canRecruiting}, status}` |
| `dispatch` | `{agent, task}` | `{accepted:true, agent, mode:"dispatch"}` |
| `ask` | `{agent, question}` | `{agent, reply, sessionId}` — `reply` is the target's last agent message; `sessionId` is the shared run session |
| `handoff` | `{agent, task}` | `{accepted:true, agent, mode:"handoff", callerStatus:"stopped"}` |
| `report` | `{status}` | `{accepted:true, agent:<caller>, status}` |
| `ask_user` | `{question, context?}` | `{parked:true, instruction}` — returns immediately; the answer is a later turn |

Delegated targets (`dispatch`/`ask`/`handoff`) run full ACP turns in the same session
under their own `agentId`, contributing their own `process`/`session_meta`/`message`/
`turn_end` events.

### 4.3 Guard rejections

A refused delegation is a **failed `tool_update`** — `status:"failed"` with
`rawOutput.error` carrying the reason. All refusals happen before any process spawns.
Current messages (match on structure, not wording):

- depth: `delegation depth 3 exceeds guards.maxDispatchDepth 2`
- fan-out: `concurrent dispatch limit reached: guards.maxConcurrentDispatches 8`
- cycle: `delegation cycle rejected: a -> b -> a`
- pipeline restriction: `dispatch is not available in pipeline mode; the backend drives
  node sequencing` (likewise `handoff`), and `agent "x" may not recruit helpers within
  its own pipeline step (allowRecruiting: false)`

Fan-out permits cover background `dispatch`/`handoff` only; synchronous `ask` calls
never consume one.

### 4.4 Usage events

`usage` payloads are discriminated (`$defs.UsagePayload`): harness updates carry
`sessionUpdate: "usage_update"` and are archived verbatim as evidence. LoomWatch does not
read them as spend: dollar budgets were retired by
[ADR 0027](decisions/0027-retire-cost-budgets.md), along with the `agent:<id>`/`team`
"budget exhausted" refusals.

Runs archived before then can hold a LoomWatch-local `phase: "budget_warning"` event
(`scope`, `spentUsd`, `limitUsd`, `warnAtPercent`). Nothing writes it any more and clients
ignore it; the schema keeps it valid so old archives still replay.

### 4.5 Status and echoes

Agent status — `idle`, `starting`, `running`, `waiting` (after `ask_user`),
`succeeded`, `failed`, `stopped` (after `handoff`); `unavailable` is reserved — is
carried inside `roster` and tool results. There is **no standalone status event**.
`handoff` marks the caller `stopped` but cannot cancel the caller's active ACP turn;
the successor starts immediately and the caller is expected to return after the
successful tool call.

A harness may also render the MCP call as its own `tool_call`/`tool_call_update`
frames with harness-specific names (e.g. `mcp__server__tool`) and different
`callId`s. ACP carries no "this is MCP" flag, so match on the bus-authored pair
(`title: "Team Bus: <tool>"`), not on harness echoes.

## 5. Pipeline-mode sequencing

- Mode comes from the team YAML: `edges: []` → team mode (all six tools exposed);
  non-empty `edges` → pipeline mode (`roster`, `ask`, `report`, `ask_user` exposed;
  `dispatch`/`handoff` withdrawn and refused if called; `ask` refused for agents with
  `allowRecruiting: false`).
- Configured edges are read from the YAML; they are not pushed as events. Execution
  order is observable as `process`/`spawned` events per `agentId`, in topological
  order, interleaved in the one dense `seq`.
- **Dataflow follows the drawn edges, not the linearized order** (TNG-46): the
  entrypoint receives the run's original prompt; a node with one configured
  predecessor receives that predecessor's last reply verbatim as its prompt; a join
  (multiple predecessors) receives each predecessor's reply labeled and concatenated
  in edge-declaration order, as `### From <predId>\n\n<reply>` blocks.
- Pipeline mode also drains delegated (recruited) tasks before the run finishes, so
  recruited helpers' events can appear after the last configured node's `turn_end`.

## 6. Example — a dispatch pair

```json
{"id":"…","sessionId":"s-1","agentId":"lead","seq":7,"ts":"…","kind":"tool_call",
 "payload":{"callId":"c-1","title":"Team Bus: dispatch","name":"dispatch","toolKind":"other",
            "status":"in_progress","rawInput":{"agent":"worker","task":"do work"}},
 "raw":{"jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"dispatch","arguments":{"agent":"worker","task":"do work"}}}}

{"id":"…","sessionId":"s-1","agentId":"lead","seq":8,"ts":"…","kind":"tool_update",
 "payload":{"callId":"c-1","status":"completed","rawOutput":{"accepted":true,"agent":"worker","mode":"dispatch"}},
 "raw":{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"…"}],
        "structuredContent":{"accepted":true,"agent":"worker","mode":"dispatch"},"isError":false}}}
```

A guard rejection is the same pair with `"status":"failed"` and
`"rawOutput":{"error":"delegation cycle rejected: a -> b -> a"}`.


### Additive operator/session metadata (2026-09-13)

The RunEvent envelope and kind enum are unchanged. These `session_meta` payload phases are additive:

- `awaiting_operator`: `kind: review_stop | question`, `node`, `question`, optional `context` and
  `handoverFrom`. The authoritative open question is `RunRecord.waitingOn` from REST.
- `session_loaded` and `session_replayed`: bracket harness history replay during `session/load`.
  Raw replay remains archived. Projection ignores only that agent's frames within the bracket,
  preserving concurrently arriving evidence from other agents.
- `turn_purpose`: `purpose: checkpoint | handover | work`. Checkpoint/handover turns retain their
  text, usage and order but do not replace the canonical answer. `work` ends the bracket.
- `prompt_sections` gains `kind: direction`; it carries the operator's instruction separately
  from `stage_results`. Review-stop nodes also record their received handover this way.

Answers are ordinary user `message` events with `raw.source: loomwatch` and
`raw.phase: operator_answer`, from the designed operator node or reserved `operator` id.
No new WebSocket subscription or event kind is required. See [ADR 0017](decisions/0017-operator-stops-and-answers.md).


### Additive required-skill and response metadata (2026-09-14)

The envelope and event kinds are unchanged:

- `prompt_sections` gains section kind `required_skill` and a `requiredSkills` list. Each entry has
  `name`, `source`, `sourcePath`, `path`, `harness`, `sha256`, and `chars`. The fingerprint covers the
  copied SKILL.md bytes, not the entire bundle. Missing list means legacy; empty list means no
  configured requirements.
- `required_skills_supplied` is emitted after a successful prompt send, with `skills` (the same
  entries), `promptId`, and `method: session/prompt`. Both preparation and send metadata have
  `raw.source: loomwatch`. The projector matches the send against preparation before marking it
  supplied. A prepared snapshot is not a send receipt.
- Agent `message` payloads may include `phase: commentary | final_answer`, normalized from explicit
  Codex ACP `_meta.codex.phase`. The original raw frame remains intact. These phases separate
  progress from delivered replies. Missing/unknown phases retain generic ACP behavior.
- A delivered reply joins the chunks of one agent message verbatim and puts separate messages a
  blank line apart. Agent `message` payloads carry the ACP `messageId` when the harness sends one,
  and a changed `messageId` starts a new message. A harness that sends no IDs starts one after any
  `tool_call`, `tool_update`, `plan` or `permission` event. The daemon (`ReplyText` in
  `acp.rs`) and the UI projection (`ui/src/lib/watch/replyText.ts`) apply the same rule.

See [ADR 0020](decisions/0020-delivery-lane-and-required-skill-receipts.md) for replay and legacy-row handling.


### Additive skill-routing and skill-evidence metadata (2026-09-20)

The envelope, the event kinds and every existing payload shape are unchanged.

- `prompt_sections` gains section kind `skill_translation` — `## Reading <skill> on <Harness>`, the
  mapping LoomWatch writes beside a skill whose instructions assume a harness facility the
  receiving agent does not have. Its own kind, not more text inside `required_skill`, because it is
  LoomWatch speaking and `required_skill` is the skill speaking. Added in one change with
  `memory::PromptSectionKind` and `ui/src/lib/watch/events.ts`, per the rule above.
- `requiredSkills` entries gain `route` (`native` / `inline` / `blocked`), `kind`
  (`artifact` / `behavior` / `portable`), `needs` (the harness assumptions found in the skill's
  text), `description`, and `bodySha256`. `sha256` is unchanged and still fingerprints the
  **delivered file**; `bodySha256` covers the frontmatter-stripped body, which is the only text
  that can enter a prompt. A missing `route` means a run archived before ADR 0021 — clients render
  those with the pre-routing wording rather than guessing one.
- `skill_opened`: `{skill, path, sha256, toolCallId}`, emitted once per skill per session when the
  agent's own stream shows a tool call reading a delivered `SKILL.md` under a managed root, or
  Claude Code's `Skill` tool naming a delivered skill. This is the explicit open event
  [RUN_PROVENANCE_CONTRACT.md](RUN_PROVENANCE_CONTRACT.md) §12 requires before a skill counts as
  used; prompt and filesystem presence still do not.
- `skill_self_report`: `{text, chars}`, the agent's own list of required-skill instructions it
  could not follow, taken from its reply. **A self-report, never provenance** — §8.2 forbids
  labelling anything as used by inference from prose. Clients must show it as the agent's claim.

Both new phases carry `raw.source: loomwatch`. See
[ADR 0021](decisions/0021-skill-routing-by-portability.md).


### Additive knowledge and tool delivery metadata (2026-10-01)

The envelope, the event kinds and every existing payload shape are unchanged.

- `prompt_sections` gains section kinds `knowledge` (`## Knowledge: <name>`, a wired knowledge
  source's contents, framed as source material) and `tool` (`## Tool: <name>`, an MCP server
  connected to the session). Added in one change with `memory::PromptSectionKind` and
  `ui/src/lib/watch/events.ts`, per the rule above.
- `prompt_sections` gains `knowledge` — `[{name, source, folders, readAccess, chars, sha256}]` — and
  `tools` — `[{name, server, provider, configPath, transport, envNames, headerNames, permission}]`.
  Each key is present only when the agent was delivered at least one of that kind, so a record from
  a run that wired neither is byte-identical to before. `readAccess` and `permission` are `granted`
  (LoomWatch wrote the allow rule into the workspace's Claude Code settings) or `harnessPolicy`.
  `envNames` and `headerNames` are names only: the values from the operator's MCP config reach the
  harness in `session/new` and are never archived.

See [ADR 0029](decisions/0029-deliver-knowledge-and-tools.md).


### Additive team-orientation metadata (2026-10-02)

The envelope, the event kinds and every existing payload shape are unchanged.

- `prompt_sections` gains section kind `team` — `## Your place in the team`, written directly under
  `## Your assigned role` for every agent on a team of two or more: who comes before it, who reads
  its work after it, and whether its reply is the team's answer. A team of one records no `team`
  section, so its record is byte-identical to before. Added in one change with
  `memory::PromptSectionKind` and `ui/src/lib/watch/events.ts`, per the rule above.

See [ADR 0034](decisions/0034-agent-context-and-team-orientation.md).


### Additive chosen-knowledge metadata (2026-10-02)

The envelope, the event kinds and every existing payload shape are unchanged.

- `prompt_sections.knowledge[]` entries gain `files` — absolute paths of single files the agent may
  read: a file the operator added to the team. Omitted when empty, so a record from a run that
  added none is byte-identical to before. `readAccess` now covers `files` as well as `folders`.
- A knowledge source the operator chose has `source` `Linked folder` or `Added file`, in place of
  the Library provenance a discovered source carries.

See [ADR 0035](decisions/0035-folders-and-files-as-knowledge.md).

Since [ADR 0036](decisions/0036-knowledge-is-chosen-not-discovered.md), every delivered knowledge
entry is one the operator chose, so new records only carry `Linked folder` or `Added file`. Records
from earlier runs may still carry a discovered source's provenance (`LoomWatch`, `OpenCode`, or
both joined with ` + `); readers must keep accepting them.


### Additive declined-request metadata (2026-10-03)

The envelope, the event kinds and every existing payload shape are unchanged.

- `permission_answered` gains `outcome: not_asked`, recorded when a routine's run, which has nobody
  to ask, declines a request at once. Its `requestId` is `null`.
- `turn_resumed`: the app ended a turn `cancelled` after `LoomWatch` declined one of its requests,
  and `LoomWatch` asked it to carry on in the same session. The payload has `stopReason: cancelled`,
  the app's `usage` when it sent one, and `declined[]` (`title`, `kind`, `detail`, `outcome`).
  `raw` is `{source: loomwatch, phase: turn_resumed, response}`, and `response` is the app's own
  `session/prompt` reply. The next user `message` is that request to carry on, not a new task. One
  `turn_end` closes the whole turn, and the reply runs across the cut.
- A `permission` reply that selects an option whose `kind` is `reject_once` or `reject_always` is a
  decline, the same as `outcome: cancelled`.

See [ADR 0046](decisions/0046-a-declined-request-does-not-end-the-turn.md).
