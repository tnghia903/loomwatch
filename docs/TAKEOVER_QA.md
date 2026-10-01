# Operator and memory takeover QA

Verified 2026-09-13 against the current uncommitted workspace, continuing the interrupted
Canvas C implementation. Earlier memory, canvas, notebook and checkpoint work was retained.

## Completed

- Operator review stops: waiting state, handover, Continue and repeated Send back.
- `ask_user`, question queues, parked sessions, session-load replay, idle release and late-answer
  checkpoint continuation. Released sessions are not charged an extra checkpoint turn.
- Replies to available live agents, with serialized turns and recorded operator direction.
- Follow-ups preserve operator direction separately from source handovers; start identity includes
  lineage. Cancellation and restart handle stale waiting state and coordinator checkpoints.
- Process exit/crash recording after a parked session; team-mode end checkpoints.
- Checkpoint and handover output stays in the transcript without replacing the actual answer.
- Expanded review/follow-up controls, readable answer fields, waiting cards and dock spacing.
- A deterministic Python ACP fixture makes `examples/operator-stop.yaml` runnable offline,
  including repeated send-back, handover and checkpoint turns.

## Automated results

| Check | Result |
| --- | --- |
| `cargo test --workspace` with local PostgreSQL | 200 library + 7 schema tests passed |
| `cargo clippy --all-targets -- -D warnings` | Passed |
| `cargo fmt --check` | Passed |
| `npm --prefix ui test` | 363 tests in 44 files passed |
| `npm --prefix ui run build` | Passed, existing bundle-size warning |
| `npm --prefix ui run lint` | No errors; six existing warnings |
| `git diff --check` | Passed |

Two focused mutation checks verified that the event regressions fail for the actual bug: allowing
checkpoint text into the answer, and allowing session-load replay into the projection. Each
produced an assertion failure; the original implementation was restored and event tests passed.

The lint warnings concern effect-driven state and the recursive `removeCapabilityCards` callback
in Workspace, plus the existing composer-layout effect. They are not claimed fixed here.

## Browser walkthrough

The daemon was built locally and run on `127.0.0.1:3010`, using its own
`loomwatch_review_20260913` database and `/tmp/loomwatch-review/teams` fixture directory. The
pre-existing server on port 3000 was left running. No paid harness or external service was used.

The walkthrough exercised a new run, a review stop, send-back with revised handover, approval,
the writer's actual answer, a Writer-only follow-up preserving the approved direction, run
history/replay, and the Memory/Brief panel. Browser inspection found and drove repairs for a
collapsed answer field, overlapping review context, and checkpoint text replacing Output.
The final review was also checked at 375 × 812: the handover scrolls, all review actions remain
inside the viewport, and the Memory panel clears the composer. Approval was submitted at that
width before restoring the default viewport.

To run the checked-in fixture yourself, build the UI and daemon, configure PostgreSQL as in the
README, then start `target/debug/loomwatchd serve --teams-root examples --listen 127.0.0.1:3010`
and open `http://127.0.0.1:3010/?path=operator-stop.yaml`. Submit a task, inspect the handover,
send it back or approve it, and inspect Writer's answer. The fixture reports zero provider cost.

## Practical limits

- Vendor-specific `session/load`, compaction and live model behavior need a separate provider
  run. Passing fake-harness protocol tests does not establish every vendor's compatibility.
- The built main JavaScript chunk exceeds Vite's 500 kB advisory threshold.
- Additional existing design tradeoffs are recorded in the implementation ledger at the end of
  [TEAM_MEMORY.md](TEAM_MEMORY.md). Operator semantics are in
  [ADR 0017](decisions/0017-operator-stops-and-answers.md).
- Changes remain uncommitted for review.
