# ADR 0015 — The `runs` table: a run record that outlives the process

Status: accepted · 2026-09-13 · amends [ADR 0008](0008-run-control-api.md) · adds
[`migrations/20260913140000_create_runs.sql`](../../migrations/20260913140000_create_runs.sql)

## Context

`RunRegistry` was a `BTreeMap<String, RunEntry>` behind an `RwLock`, declared in
`runs.rs` with the comment "the registry is in-memory and lives as long as the daemon". Everything
about a run except its events lived there: status, timings, the canonical reply, the stable error
code, the delivery outcome of a routine, and the start keys that make a resubmitted `POST /api/runs`
idempotent.

Four things that cost:

1. **A restart loses every run.** `run_events` still holds the evidence, so the archive can replay
   a session — but nothing holds the *record*. `mergeHistory` in the UI carries a
   `legacyOperatorPrompt` fallback precisely for runs the daemon has forgotten, and the fallback
   guesses the operator's prompt out of the first archived user message, which for a
   LoomWatch-composed run is the role, the capabilities, the memory packet *and* the task.
2. **Idempotency is process-scoped.** A start key bound before a restart is unknown after it, so
   an operator whose submit was interrupted by a restart starts a second run.
3. **Retry lineage was never server-side at all.** [ADR 0009](0009-prompt-to-output-workspace-shipped.md)
   records it as client-side session state, and it is a React `useState(new Map())` in
   `Workspace.tsx` — which does not survive a page reload either.
4. **Two tracks are blocked on it.** Canvas B's follow-ups need `followsRunId`/`startAt` so
   earlier stages replay from `context_packets` instead of re-running; Canvas C's operator stops
   need `waitingOn` so a parked question survives a restart. `docs/TEAM_MEMORY.md` §6 lists the
   table as decided (decision 5) and says it gets its own ADR before phase 3. This is it.

## Decision

### 1. One table, holding what `RunRecord` holds, plus lineage

`runs` carries every field of `RunRecord` and four more: `follows_run_id`, `start_at`,
`retry_of_run_id` and `waiting_on`. It also carries `start_key` and `start_fingerprint`, so the
idempotency binding is as durable as the run it points at.

`run_events` is untouched. That is the whole shape of this decision: **a run's evidence is
append-only and a run's record is mutable state**, and they are different tables because they are
different things. A `runs` row's status moves forward, its delivery is stamped after it finishes,
and a follow-up may be attached to it later. An event is never any of those.

### 2. The cache stays the authority on a record's shape

`RunRegistry` keeps its in-memory map and its synchronous, forward-only transition methods
(`mark_starting`, `mark_running`, `mark_succeeded`, `mark_failed`, `cancel`). Persistence is a
separate, explicit step:

- `RunRegistry::durable(store)` gives the registry a `RunStore`.
- `RunRegistry::persist(run_id).await` upserts the cached record. The async call sites that change
  a record call it: the `POST /api/runs` handler before it answers, `execute` at every transition,
  `cancel_run`, and the scheduler after it stamps a delivery.
- `RunRegistry::reload().await` fills a cold cache at boot, oldest first, bounded to 500 records.

Three alternatives were rejected:

- **Making the transition methods async.** They are called from synchronous tests and from the
  scheduler's synchronous `launch`, and the ripple is large for no gain — the transition rules are
  not what needs the database.
- **A write-behind channel.** It removes the explicit call, and replaces it with a test that has
  to wait for a flush and a failure mode where the process exits with writes still queued.
- **Targeted `UPDATE` statements per transition.** That is a second implementation of the
  forward-only rules, in SQL, where getting them wrong is silent. The upsert has one job: make the
  row equal the record.

A registry with no store is byte-for-byte the registry this was before, which is what keeps the
existing tests and the no-archive daemon honest rather than degraded.

### 3. A recovered run holds no task handle

`RunEntry::handle` is `None` for every reloaded record. Cancelling a recovered run therefore
changes the record and aborts nothing — which is the truth after a restart. The alternative,
pretending a run is still live because its status says `running`, would tell the operator a
process was killed when none was.

A record that was `running` when the daemon died stays `running` after recovery. It is not
rewritten to `failed`: the daemon does not know whether the harness finished, and inventing a
terminal status is exactly the kind of minted fact
[`RUN_PROVENANCE_CONTRACT.md`](../RUN_PROVENANCE_CONTRACT.md) forbids. Reconciling an interrupted
run against its archived events is its own change, and the columns it needs are here.

### 4. `followsRunId` and `startAt` are columns and fields, with no behaviour

`POST /api/runs` does not accept them yet. Shipping the record shape first means Canvas B is a
handler change instead of a handler change plus a migration, and it means the fields exist for the
UI to read before anything sets them.

### 5. `list_sessions` reports the recorded task

Separate from the table but the same problem: `SessionSummary` gains `task`, read with a lateral
join from the first `session_meta` / `prompt_sections` record's `task` section — beside the
existing prompt lateral, bounded to one row the same way. New runs therefore need no
`legacyOperatorPrompt`. The fallback stays for runs archived before phase 1 added the record,
where `task` is honestly `None`.

## Consequences

- Run history survives a restart, and so does idempotency.
- Every run costs one extra upsert per lifecycle transition — five or six statements per run,
  against a run that spawns processes and archives hundreds of events.
- The UI can stop synthesising retry lineage once a later change starts writing
  `retry_of_run_id`; until then the column is unread and the React `Map` remains.
- An interrupted `running` record needs reconciliation, which does not exist yet. That is a known
  gap, named in `docs/TEAM_MEMORY.md`'s ledger rather than hidden behind a status rewrite.

## Gate

`cargo test -p loomwatch-backend` —
`runs::tests::run_records_and_their_start_keys_survive_a_registry_reload` writes a record through
one durable registry, reloads a second one on the same pool, and asserts the record, its lineage
fields and its start-key binding all come back; its counterfactual is a registry with no store,
which persists nothing and recovers nothing.
`archive::tests::session_listing_reports_the_recorded_task_section` pins the task lateral, and
pins the honest `None` for a run with no record.
