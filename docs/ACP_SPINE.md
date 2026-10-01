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

Permission negotiation was re-verified end to end on 2026-09-06 with Hermes Agent 0.21.0
(`hermes-acp`) and [`examples/phase03-hermes-acp.yaml`](../examples/phase03-hermes-acp.yaml).
Live session `5c5a7645-b50f-4652-a7f9-95b5f857117d` asked Hermes to make one harmless
`write_file` call. Hermes emitted `session/request_permission` at archive sequence 82 with
`allow_once` and `reject_once` options; LoomWatch archived its response at sequence 83 with
`{"outcome":"selected","optionId":"deny"}`. The requested file remained absent and Hermes
completed the turn normally. This verifies the real `reject_once` path outside the in-process
mock test.

Hermes' edit gate advertises `reject_once` but not `reject_always`, so the latter remains the
tested fallback for harnesses that omit a one-shot rejection. A complementary live terminal
probe did not improve that evidence: Hermes' default `approvals.mode: smart` classified the
harmless command as safe and auto-approved it before ACP permission negotiation. OpenCode
1.18.23 in `acp --pure` mode likewise auto-approves its own tool calls and did not emit
`session/request_permission` during the Phase 02 probe.

### `reject_always` is unreachable with every harness LoomWatch currently targets (TNG-47)

TNG-30 and TNG-44 closed the `reject_once` half of this question but left `reject_always`
unverified: `acp.rs` only selects it when a harness offers *no* `reject_once` option (see
`build_client_response` in `crates/loomwatch-backend/src/acp.rs`). TNG-47 checked every
harness family in the README's spawn table — `claude-agent-acp`, `codex-acp`, Gemini CLI ACP
mode, and Hermes/OpenCode as `opencode acp` stand-ins — against that specific shape and found
none of them can produce it, by construction of their own permission-option builders, not by
chance non-triggering in a single probe:

- **`@agentclientprotocol/claude-agent-acp` 0.75.1** (npm; the current package for the
  README's `claude-agent-acp`, formerly `@zed-industries/claude-code-acp`). Its
  `dist/permissions/options/*.js` never defines a `reject_always` kind at all — `shared.js`'s
  `reject()` helper hard-codes `kind: "reject_once"`, and every option builder
  (`buildReadPermissionOptions`, `buildEditPermissionOptions`, `buildBashPermissionOptions`,
  `buildFallbackPermissionOptions`, etc.) calls it unconditionally. Confirmed live: a raw ACP
  session against this package defaults `session/new`'s `mode` config option to `"auto"`
  ("Claude handles permission decisions"), which auto-approves and never calls
  `session/request_permission` — a fourth instance of the auto-approve pattern already seen
  in Hermes `smart` and OpenCode `acp --pure`. Switching to manual gating requires
  `session/set_config_option` with `{"configId":"mode","value":"default"}` *before*
  `session/prompt`. Once in `"default"` mode, a real `write_file` permission request arrived
  with options `[{"kind":"allow_once"},{"kind":"allow_always"},{"kind":"reject_once"}]` — no
  `reject_always` — and LoomWatch's existing `reject_once`-preferring logic selected `reject`,
  which the harness honored (`permission denied`, file not written). **Anyone spawning
  `claude-agent-acp` for real work must budget for this: LoomWatch will archive zero
  `permission` events by default unless it explicitly negotiates `mode: "default"` first.**
- **`@agentclientprotocol/codex-acp` 1.10.0** (npm; the README's `codex-acp`, wrapping the
  local `codex` CLI's app-server). `src/permissions/options.ts`'s
  `defaultCommandDecisions()` unconditionally appends `"decline"` and `"cancel"` — both map to
  `kind: "reject_once"` — to every decision list it builds. `reject_always` appears exactly
  once in the bundle, as the "No, and block this host in the future" option for a proposed
  *network policy amendment*, and it is only ever pushed alongside the ambient
  `decline`/`cancel` reject_once pair, never in their place. Confirmed live: this package's
  default session mode is `"agent"` ("Approve for me" — only flags actions it judges unsafe),
  which auto-approved both a `touch` and a `curl` to an external host without any
  `session/request_permission`. Switching to `"read-only"` ("Ask for approval") via
  `session/set_config_option {"configId":"mode","value":"read-only"}` still did not produce a
  permission request for either call in this environment — the failed `curl` (exit 6, DNS
  resolution failure) points at network being cut at the OS sandbox layer below ACP, not at
  ACP-level negotiation, so no `permission` event was observable at all for this probe shape.
  Reaching the one code path that emits `reject_always` would need a prompt that gets codex to
  propose the network-policy-amendment decision specifically, which was not exercised.
- **Gemini CLI 0.54.4** (`@google/gemini-cli`, `gemini --acp`). Its bundled
  `toPermissionOptions()` builds a static `[allow_once, reject_once]` base for every
  confirmation kind (`edit`, `exec`, `mcp`, `info`, `ask_user`) and only ever *adds*
  `allow_always` variants on top; `reject_always` occurs exactly once in the entire bundle, in
  the zod schema (`zPermissionOptionKind`) that validates the ACP-spec enum — it is never
  constructed. This could not be confirmed live: this dev machine's `oauth-personal` (free
  tier) auth throws `IneligibleTierError` ("This client is no longer supported for Gemini Code
  Assist for individuals... migrate to Antigravity") before `session/new` completes, so Gemini
  CLI ACP mode cannot presently be driven at all here, independent of this question.
- **Hermes 0.21.0** and **OpenCode 1.18.23** — already documented above: Hermes offers
  `reject_once` without `reject_always`; OpenCode `acp --pure` offers neither because it
  auto-approves.

**Conclusion:** across every harness family in the README's spawn table, `reject_always`
either never appears (Gemini, OpenCode) or appears only as an addition alongside an
already-present `reject_once` (`claude-agent-acp` never at all; `codex-acp` only bundled with
`decline`/`cancel`). None can currently produce the shape `acp.rs`'s fallback branch exists
for — a harness offering *only* an always-style rejection — so that branch stays verified by
the in-process mock test in `acp.rs` (search `reject_always` in that file) and not by a live
harness. This is a property of how these harnesses build their option lists today, not a gap
in how many were tried; a future harness or harness version could still change this, so the
branch should not be deleted. It does not affect the Team Bus guards in
[ARCHITECTURE.md §3](ARCHITECTURE.md#3-team-bus--delegation-as-protocol) — permission
negotiation and delegation-guard enforcement are independent code paths — but the auto-approve
default in `claude-agent-acp` (`mode: "auto"`) and `codex-acp` (`mode: "agent"`) is a real gap
for anyone building on the `permission` event archive: both need an explicit
`session/set_config_option` before archived `permission` events will exist at all when
LoomWatch spawns them for real work, not just for this probe.

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

The Phase 03 permission probe uses the same native workflow with the Hermes example:

```sh
hermes-acp --check

loomwatchd run \
  --team examples/phase03-hermes-acp.yaml \
  --prompt 'Use the write_file tool exactly once (do not use terminal or patch) to create /tmp/loomwatch-permission-probe containing exactly permission probe. If denied, do not retry; reply exactly: permission denied.'
```

Hermes uses credentials and the provider/model from its local configuration. Confirm those
settings and their pricing before running this smoke test. LoomWatch sets no spend ceiling
(dollar budgets were retired by ADR 0027), so the provider's own limits are the only ones. The
example explicitly disables the environment-variable hook and YOLO bypasses, but LoomWatch is
still an observer rather than a sandbox. Inspect the two archived `permission` events with
`loomwatchd show`, and verify that the probe file was not created. Hermes 0.21 advertises models
through ACP's typed `models` state rather than a `model` config option, so the archived
`session_new` event is authoritative for the model actually used; LoomWatch records its
team-file model setting as skipped.
