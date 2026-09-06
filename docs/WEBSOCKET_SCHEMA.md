# WebSocket message schema

Revision 1 · 2026-09-06 · **frozen per [ARCHITECTURE.md §7](ARCHITECTURE.md#7-build-phases)**

This document freezes the message schema `loomwatchd` pushes to the macOS app over
WebSocket at the end of Phase 03, incorporating the TNG-42 Phase 03 review (its wire
findings landed as TNG-45 and TNG-46). Phase 04 (Canvas) and Phase 05 (Watch & alert)
build against it; any change requires a new ADR under `docs/decisions/`.

**Frozen as a paper contract.** There is no WebSocket server in the repo yet — no
transport, endpoint, or reconnect behavior exists to validate against. What is frozen
is the message payload, and the payload is the Phase-02 `RunEvent` contract, unchanged:
**a WebSocket message is one JSON-serialized `RunEvent`**. The WebSocket envelope and
framing are the only genuinely new surface Phase 04/05 add.

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
| `usage` | `$defs.UsagePayload` — see §4.4 | harness updates and Team Bus budget warnings |
| `turn_end` | `$defs.TurnEndPayload`: `{stopReason, usage?}`; `stopReason` ∈ `end_turn`/`max_tokens`/`max_turn_requests`/`refusal`/`cancelled` (default `end_turn` if the harness omits it) | one per turn; `usage.costUsd` is accounted toward budgets |
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
HTTP MCP — the agent has no bus access), and `unprojected_session_update` (an update
that could not be normalized; `warning` plus the raw update).

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
| `escalate` | `{reason}` | `{accepted:true, notify:"user", reason}` — Phase 05 fires a local notification on it |

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
- agent budget: `agent:c budget exhausted: spent $1.000000 of $1.000000`
- team budget: `team budget exhausted: spent $… of $…`
- pipeline restriction: `dispatch is not available in pipeline mode; the backend drives
  node sequencing` (likewise `handoff`), and `agent "x" may not recruit helpers within
  its own pipeline step (allowRecruiting: false)`

Budgets are **admission thresholds, not interruptions**: the bus refuses new
delegations at the threshold but never stops the entrypoint or an in-flight turn, so
observed spend may exceed a limit. Fan-out permits cover background
`dispatch`/`handoff` only; synchronous `ask` calls never consume one.

### 4.4 Budget warnings

`usage` payloads are discriminated (`$defs.UsagePayload`): harness updates carry
`sessionUpdate: "usage_update"` (spend deltas as `costUsd`), while LoomWatch-local
control-plane events carry `phase`. Today the only control-plane usage event is the
budget warning:

```json
{"phase":"budget_warning","scope":"agent:c","spentUsd":1.0,"limitUsd":1.0,"warnAtPercent":80}
```

`scope` is `team` or `agent:<id>` of the delegation target. Emitted at most once per
scope per run, on the first delegation attempt at or past `warnAtPercent` of the
limit; the limit itself is a hard refusal (§4.3). Spend is summed from
harness-supplied `usage`/`turn_end` `costUsd` deltas.

### 4.5 Status and echoes

Agent status — `idle`, `starting`, `running`, `waiting` (after `escalate`),
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
  non-empty `edges` → pipeline mode (`roster`, `ask`, `report`, `escalate` exposed;
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
