# 0008 — Run control API: start, watch, and stop a team from the browser

- **Date:** 2026-09-10
- **Status:** Accepted — implemented in `crates/loomwatch-backend/src/runs.rs`
- **Decided by:** backend, to unblock the web UI rewrite that consumes it
- **Reverses:** none. This is the first shipped slice of the control plane that
  [0005](0005-run-control-and-companion-provenance-channel.md) describes; 0005 remains the
  target for immutable runs and provenance and is not superseded.

## Context

Until now the only way to execute a team was `loomwatchd run --team … --prompt …`. The web
UI can compose a team and follow archived sessions over `/api/session/stream`, but cannot
start or stop anything, so an operator needs a terminal beside the browser.

The evidence stream is keyed by `sessionId`, and the first ACP harness used to mint it from
its own `session/new` response. A client therefore could not know what to subscribe to until
a process had already spoken — and had nothing at all to show for a run whose harness failed
before negotiating.

## Decision

1. **The archive session id is pre-minted and equals the run id.** `POST /api/runs` mints
   a UUID v4 before any process exists, creates the run's `EventLog` under it, and hands that
   log to the root process (team mode) or seeds it as the shared log of every pipeline node.
   The record exposes the same value as both `runId` and `sessionId`. Raw frames are
   untouched: each harness still negotiates and records its own ACP session id. The CLI path
   is unchanged and keeps the harness-minted id.
2. **The registry is in memory.** `RunRegistry` holds one record per run plus the tokio
   `JoinHandle` driving it, for the life of the daemon. Status moves forward only
   (`queued → starting → running → succeeded | failed | cancelled`); terminal states never
   change, so a late transition from an already-cancelled task is dropped rather than
   resurrecting the run.
3. **Run control is loopback-only.** The router is wrapped in the same `local_evidence`
   middleware as the exact-evidence routes (loopback `Host`, same-origin `Origin` and Fetch
   Metadata, `Cache-Control: no-store`). Starting processes must never be reachable from a
   non-local origin, and the archive is required (503 otherwise) because a run without an
   archive would be invisible to the UI.
4. **Cancel is abort plus `kill_on_drop`.** Cancelling aborts the run task. Dropping the
   task drops its `AcpProcess`, whose child was spawned with `kill_on_drop(true)`, so the
   harness dies. Because delegated helpers run as detached tasks that each hold the Team
   Bus, the run future also owns a `TeamBusTeardown` guard whose drop aborts every delegated
   task (killing their children the same way) and the bus's MCP server task. Tests assert
   the harness pid is gone, the helper pid is gone, and the bus port is closed.
5. **`running` is observed from the archive, not signalled by the runner.** The run task
   polls `event_page(runId, -1, 1)` every 250 ms until the run's first archived event is the
   entrypoint's `process: spawned` marker. This keeps the runner free of callbacks and means
   "running" has the same meaning as what the viewer can already see.
6. **A harness that never negotiates still leaves evidence.** With a pre-minted (or shared)
   log available, a failure before `session/new` now archives a `process: crashed` marker
   under the run's session, so the stream shows the failure instead of staying empty.
7. **Session discovery carries the prompt.** `GET /api/sessions` gains `prompt` (text of the
   first archived user `message`, structured or bare-string content, `null` if none) and
   `firstAgentId` (agent of the lowest `seq`), computed with bounded lateral lookups in SQL.

## Deliberately not done

- **Persistence of the registry across restarts.** After a restart `GET /api/runs` is empty;
  the archive still holds every event and `GET /api/sessions` still lists them. A durable run
  table is 0005's immutable run record and comes with its snapshot semantics.
- **Run snapshots and expected revisions** per `RUN_PROVENANCE_CONTRACT.md` §2–§3. A run
  executes the team file as it is on disk when the run task loads it, not immutable bytes
  pinned at start. Save/start races are therefore still possible.
- **The companion provenance channel** (projection, `TraceObservation`s, SSE, redaction)
  from 0005 §5–§7. The UI watches runs through the exact evidence stream only.
- **Idempotency keys, principals, and `runs:evidence` authorization.** Loopback and
  same-origin checks are the whole boundary, exactly as for the evidence routes.
- **A cancellation marker in the archive.** Cancel does not append an event; the run record
  is the source of truth for terminal classification, as 0005 §4 already intends.

## Consequences

- The UI can start a run, immediately open `/api/session/stream?session=<runId>`, and poll
  `GET /api/runs/{id}` for the terminal status, reply, exit code, and error.
- `WEBSOCKET_SCHEMA.md` §1 is amended by one sentence: API-started runs use a
  LoomWatch-minted `sessionId`; no frame or kind changes.
- `run_team_session_with_session_id` is the reusable entry for any future controller that
  needs the archive key up front; the CLI keeps `run_team_session`.
