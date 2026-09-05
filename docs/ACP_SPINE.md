# Phase 02 ACP spine

LoomWatch's first supported harness is OpenCode 1.18 (`opencode acp`). It is installed on
the development machine, reaches both free and authenticated model providers, and exposes
the current ACP v1 lifecycle without requiring another adapter package. The other supported
harnesses remain configuration choices; the backend does not contain OpenCode-specific
process or transport code.

For one turn, `loomwatchd` performs this line-delimited JSON-RPC sequence over the child
process's standard input and output:

1. `initialize` with ACP protocol version 1 and the client's deliberately minimal
   filesystem/terminal capabilities.
2. `session/new` with the resolved agent working directory.
3. `session/set_config_option` to apply the team file's model exactly.
4. `session/prompt`, while translating `session/update` notifications into ordered
   `RunEvent` rows.
5. `session/close`, followed by stdin EOF and a bounded wait for clean process exit.

Standard error is drained concurrently so a chatty harness cannot deadlock. If the child
exits early, returns a JSON-RPC error, or fails to exit after stdin closes, the supervisor
returns a contextual error; once `session/new` has succeeded, that error includes the session
identifier and the archive ends with a `process: crashed` marker so the partial run remains
recoverable. A hung child is killed and reaped. SQLite is switched to WAL mode before the
event table is created. The `show` command opens the database independently and replays a
session by its strictly increasing sequence number.

The `initialize`, `session/new`, and `session/set_config_option` responses are archived as
`session_meta` events, including the applied model and the harness's complete negotiated state.
When a harness requests permission, LoomWatch chooses an advertised `reject_once` option so it
can decline the individual tool call without cancelling the turn; both the request and the
client response are archived as `permission` events.

ACP emits more than the original Phase-01 `text | tool_call | result` sketch could retain:
thoughts, incremental tool updates, plans, permissions, usage, session metadata, and turn
completion, plus tool status, display title, locations, and raw input/output. Phase 02
therefore normalizes those categories and retains every complete JSON-RPC frame under
top-level `raw`, before the internal event contract freezes.

## Smoke test

From the repository root:

```sh
cargo run --package loomwatch-backend --bin loomwatchd -- run \
  --team examples/phase02-opencode.yaml \
  --database /path/to/loomwatch-smoke.sqlite3 \
  --prompt 'Reply with exactly: loomwatch ACP smoke ok'
```

Use the printed session identifier to verify recovery after the harness exits:

```sh
cargo run --package loomwatch-backend --bin loomwatchd -- show \
  --database /path/to/loomwatch-smoke.sqlite3 \
  --session SESSION_ID
```
