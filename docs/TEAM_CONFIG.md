# Team configuration contract

LoomWatch team files are YAML documents validated against
[`schemas/team.schema.yaml`](../schemas/team.schema.yaml). The initial contract is schema
version `1`; readers must reject a version they do not understand instead of guessing.

The root document stores stable, user-authored configuration only: the team identity,
entrypoint, budgets, guard policy, agents, and configured pipeline edges. Observed edges,
agent status, and run events are runtime records archived in SQLite. Their shared wire
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
- Each `budget.limitUsd` is a hard per-run ceiling and must be finite. A zero agent limit
  disables paid execution for that agent. When present, the team budget is enforced
  independently of agent budgets; a run halts on whichever ceiling is reached first, and
  the team limit need not equal or exceed the sum of agent limits. Loaders apply
  `warnAtPercent: 80` whenever it is absent; schema defaults are annotations only.
- `guards.maxDispatchDepth` defaults to `8` when absent. The Team Bus refuses dispatches
  beyond that depth. `Agent.allowRecruiting` defaults to `true`; `false` forbids that agent
  from recruiting helpers within its own pipeline step.
- `status` is a runtime annotation. Team-file writers must not persist it, and team-file
  readers must ignore it if an older or external document contains it.
- Run-event IDs are unique. `RunEvent.agentId` names an agent in the team document. `seq`
  is strictly increasing per session across all agents and is the sole replay order;
  timestamps are descriptive and do not replace sequence order.
- A `result` event's `callId` matches a prior `tool_call` in the same session, and the
  result's `seq` is greater than the tool call's `seq`.

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
