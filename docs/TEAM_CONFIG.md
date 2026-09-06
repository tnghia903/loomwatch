# Team configuration contract

LoomWatch team files are YAML documents validated against
[`schemas/team.schema.yaml`](../schemas/team.schema.yaml). The initial contract is schema
version `1`; readers must reject a version they do not understand instead of guessing.

The root document stores stable, user-authored configuration only: the team identity,
entrypoint, budgets, guard policy, agents, and configured pipeline edges. Observed edges,
agent status, and run events are runtime records archived in Postgres. Their shared wire
shapes are defined as `$defs.Edge` and `$defs.RunEvent` in the same schema so Phase 02 and
later can reference one contract.

See [`examples/research-team.yaml`](../examples/research-team.yaml) for a complete team.

## Semantic rules

JSON Schema validates each value's shape. Loaders must additionally enforce the rules that
depend on the document as a whole:

- Agent IDs are unique, and `entrypoint` names an agent in `agents`.
- An empty `edges` array selects team mode: the entrypoint receives the initial goal and
  self-organizes. A non-empty `edges` array selects pipeline mode: the backend executes the
  graph, and `entrypoint` must be a source node with no incoming configured edge.
- Edge endpoints name agents in the same document, self-edges are rejected, and duplicate
  configured edges with the same `from` and `to` are rejected.
- Configured edges form a directed acyclic graph. Every configured edge has
  `layer: configured` and `kind: sequence`.
- Pipeline dataflow follows the configured edges, not just the linearized run order: each
  non-entrypoint node's prompt is built from the replies of its own configured predecessors,
  looked up by `to`/`from`, not from whichever node happens to run immediately before it in
  `pipeline_order()`. A node with exactly one configured predecessor receives that
  predecessor's reply verbatim (so every linear chain, including
  [`examples/research-team.yaml`](../examples/research-team.yaml), is unaffected). A node
  with more than one configured predecessor β€” a join in the DAG, e.g. a diamond `a→b`,
  `a→c`, `b→d`, `c→d` β€” receives every predecessor's reply, each labeled with its agent ID
  and concatenated in the order those edges are declared in the team file, so a branch is
  never silently dropped. Only the entrypoint (`pipeline_order()`'s first node) receives the
  run's original prompt.
- Every edge and run-event `ts` must parse as RFC 3339 or the loader rejects it. The schema
  `format` keyword is an annotation in Draft 2020-12 and must not be relied on for this;
  the companion `pattern` constrains shape only, so the loader still range-checks the
  fields. RFC 3339 spells its literals case-insensitively, and `RunEvent.ts` is minted
  upstream, so the lowercase `t` and `z` separators are accepted on read. LoomWatch emits
  the uppercase form.
- Child processes inherit the LoomWatch process environment. `spawn.env` entries are
  applied on top as literal overrides; LoomWatch performs no shell expansion, and team
  files must not contain credentials. An override of `PATH` changes resolution of a bare
  `spawn.cmd`, so an untrusted team file must be treated with the same care as a script.
- Each `budget.limitUsd` is a pre-delegation admission threshold and must be finite. A zero
  agent limit prevents that agent from being admitted through `dispatch`, `ask`, or
  `handoff`. When present, the team threshold is checked independently of agent thresholds,
  and need not equal or exceed their sum. These checks do not stop the entrypoint or an
  in-flight turn, so observed spend may exceed a threshold. Loaders apply `warnAtPercent:
  80` whenever it is absent; schema defaults are annotations only.
- The Team Bus accounts non-negative finite `costUsd` values from normalized `usage` events
  and from `turn_end.payload.usage`. These values are spend deltas supplied by the ACP
  harness; the bus does not infer whether a reported value is cumulative, so harnesses must
  normalize cumulative provider totals into deltas. Before `dispatch`, `ask`, or `handoff`
  starts another process, the bus checks the target agent and team totals, archives one
  `usage` warning per scope after its threshold, and archives a failed `tool_update` when it
  refuses the delegation.
- `guards.maxDispatchDepth` and `guards.maxConcurrentDispatches` both default to `8` when
  absent. The Team Bus refuses delegation beyond the depth limit and refuses a background
  `dispatch` or `handoff` while the configured number of those tasks is still running.
  Delegation lineage and concurrency permits are server-owned, so callers cannot forge the
  counter, erase an ancestor to bypass cycle detection, or race past the fan-out cap.
  Synchronous `ask` calls do not consume a background-dispatch permit. `Agent.allowRecruiting`
  defaults to `true`; `false` forbids that agent from recruiting helpers within its own
  pipeline step.
- `handoff` starts the target as a background task and marks the caller's roster status as
  `stopped`, but it cannot cancel the caller's current ACP turn. The caller must return after
  a successful handoff; provider spend can continue until that turn exits.
- `status` is a runtime annotation. Team-file writers must not persist it, and team-file
  readers must ignore it if an older or external document contains it.
- Run-event IDs are unique. `RunEvent.agentId` names an agent in the team document. `seq`
  is strictly increasing per session across all agents and is the sole replay order;
  timestamps are descriptive and do not replace sequence order.
- A `tool_update` event's `callId` matches a prior `tool_call` in the same session, and the
  update's `seq` is greater than the tool call's `seq`.

Paths in `spawn.cwd` may be absolute or relative. A relative path is resolved against the
directory containing the team file. `spawn.cmd` must be either a bare executable name
resolved on the effective `PATH` after applying `spawn.env`, or an absolute path. Relative
commands containing a path separator are rejected. The command is executed directly with
`spawn.args`; it is never passed through a shell.

## Reusable runtime definitions

Schema-aware consumers can validate runtime values directly with these references:

- `schemas/team.schema.yaml#/$defs/Agent`
- `schemas/team.schema.yaml#/$defs/Edge`
- `schemas/team.schema.yaml#/$defs/RunEvent`

The `RunEvent.payload` shape is selected by `kind`. Message and thought events retain a
role, optional upstream message ID, and structured ACP content block. Tool calls and tool
updates project the call ID, title, kind, status, input/output, content, and locations when
present. Plan, permission, session-metadata, usage, turn-end, and process events cover the
rest of the ACP and supervisor lifecycle. Every harness-originated event also stores the
complete JSON-RPC frame in top-level `raw`, because ACP presentation and status metadata
cannot be reconstructed safely from the normalized projection.
