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
3. `session/set_config_option` to apply the team file's model when `session/new` advertises
   a `model` config option; otherwise LoomWatch records that configuration was skipped.
4. `session/prompt`, while translating `session/update` notifications into ordered
   `RunEvent` rows.
5. `session/close`, followed by stdin EOF and a bounded wait for clean process exit.

Standard error is drained concurrently so a chatty harness cannot deadlock. If the child
exits early, returns a JSON-RPC error, or fails to exit after stdin closes, the supervisor
returns a contextual error; once `session/new` has succeeded, that error includes the session
identifier and the archive ends with a `process: crashed` marker so the partial run remains
recoverable. That marker carries the exit code and, when a signal terminated the child (the
common `SIGKILL` timeout path), the signal name — a bare `exitCode: -1` on its own cannot be
told apart from a genuine −1 exit. A hung child is killed and reaped. Postgres stores
`payload` and `raw` as JSONB, and a versioned `sqlx` migration enforces the event-kind check
and unique `(session_id, seq)` replay order. The `show` command opens an independent Postgres
connection and replays a session by its strictly increasing sequence number.

On the ten-minute per-request timeout, LoomWatch sends a best-effort `session/cancel`
notification before it closes the transport, so a well-behaved harness can stop working — and
stop spending — instead of running until the process kill lands. The child is still torn down
and, if it does not exit during the bounded shutdown wait, killed and reaped; `session/cancel`
only narrows the window, and a wedged harness may never observe it.

The `initialize` and `session/new` responses, plus `session/set_config_option` when sent, are
archived as `session_meta` events, including the applied model and the harness's complete
negotiated state.
When a harness requests permission, LoomWatch chooses an advertised `reject_once` option, or
`reject_always` when that is the only rejection offered, so it can decline the tool call without
cancelling the turn; both the request and the client response are archived as `permission`
events.

Permission negotiation is currently covered with a mock harness only. OpenCode 1.18.23 in
`acp --pure` mode auto-approves its own tool calls and did not emit
`session/request_permission` during the Phase 02 probe; exercise this path against a second
real harness when one is added.

LoomWatch observes and archives an agent process; it does not sandbox it. Declaring filesystem
and terminal client capabilities as unavailable only says that LoomWatch does not provide those
ACP services. A harness can still use its own tools to read, write, execute, or access the network
with the permissions of the spawned process. Run untrusted harnesses inside an external sandbox.

ACP emits more than the original Phase-01 `text | tool_call | result` sketch could retain:
thoughts, incremental tool updates, plans, permissions, usage, session metadata, and turn
completion, plus tool status, display title, locations, and raw input/output. Phase 02
therefore normalizes those categories and retains every complete JSON-RPC frame under
top-level `raw`, before the internal event contract freezes.

## Smoke test

Docker Compose is not a runtime for `loomwatchd`. After starting Postgres and installing a
packaged native LoomWatch build, export the native connection URL and run the binary on the
host so it can launch host-installed ACP harnesses:

```sh
docker compose up -d postgres
set -a
. ./.env
set +a
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"

loomwatchd run \
  --team examples/phase02-opencode.yaml \
  --prompt 'Reply with exactly: loomwatch ACP smoke ok'
```

Use the printed session identifier to verify recovery after the harness exits:

```sh
loomwatchd show \
  --session SESSION_ID
```
