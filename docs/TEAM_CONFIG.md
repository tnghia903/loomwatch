# Team configuration contract

LoomWatch team files are YAML documents validated against
[`schemas/team.schema.yaml`](../schemas/team.schema.yaml). The initial contract is schema
version `1`; readers must reject a version they do not understand instead of guessing.

The root document stores stable, user-authored configuration only: the team identity,
entrypoint, agents, and configured pipeline edges. Observed edges and run events are
runtime records archived in SQLite. Their shared wire shapes are defined as `$defs.Edge`
and `$defs.RunEvent` in the same schema so Phase 02 and later can reference one contract.

See [`examples/research-team.yaml`](../examples/research-team.yaml) for a complete team.

## Semantic rules

JSON Schema validates each value's shape. Loaders must additionally enforce the rules that
depend on the document as a whole:

- Agent IDs are unique, and `entrypoint` names an agent in `agents`.
- Edge endpoints name agents in the same document, and self-edges are rejected.
- Configured edges form a directed acyclic graph. Every configured edge has
  `layer: configured` and `kind: sequence`.
- Environment entries are literal child-process additions. LoomWatch does not perform
  shell expansion and team files must not contain credentials.
- `budget.limitUsd` is a hard per-run ceiling. A zero limit disables paid execution for
  that agent.
- Run-event IDs are unique. `seq` is strictly increasing within a session and provides
  replay order; timestamps are descriptive and do not replace sequence order.

Paths in `spawn.cwd` may be absolute or relative. A relative path is resolved against the
directory containing the team file. `spawn.cmd` is executed directly with `spawn.args`;
it is never passed through a shell.

## Reusable runtime definitions

Schema-aware consumers can validate runtime values directly with these references:

- `schemas/team.schema.yaml#/$defs/Agent`
- `schemas/team.schema.yaml#/$defs/Edge`
- `schemas/team.schema.yaml#/$defs/RunEvent`

The `RunEvent.payload` shape is selected by `kind`: text events contain `text`, tool calls
contain `callId`, `name`, and object-valued `arguments`, and results contain `callId`,
lossless `content`, and `isError`.
