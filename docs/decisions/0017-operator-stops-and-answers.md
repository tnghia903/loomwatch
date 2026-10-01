# ADR 0017: Operator stops, questions and answer turns

Date: 2026-09-13. Status: implemented; offline verification in [TAKEOVER_QA](../TAKEOVER_QA.md).

A person can now participate as a pipeline node without an ACP request waiting on human time.
The work remains on the same canvas while the run waits, receives a decision, and continues.

1. `kind: operator` has a question (`role`) and a display name, defaulting to `You`. Harness
   configuration on this node is refused. Operator nodes require a pipeline, cannot be its
   entrypoint, and start no process. The CLI refuses them before any harness is launched.
2. `RunRecord.waitingOn` describes the visible open question, its node, timestamp, handover and
   parking tier. Run status remains `running`. The registry queues concurrent questions and
   advances the visible one when it is answered. `operator_questions` stores question lineage;
   its partial unique index enforces one open question per run/agent.
3. `POST /api/runs/{id}/answers` accepts `{node,text,sendBack?}`. Wrong/stale addresses, unavailable
   send-back targets and empty answers are refused. Continue records the answer as the operator
   node's user message and supplies it to the successor under `Direction from you`. Send back
   prompts the predecessor in the same session, then repeats the stop with a fresh handover.
4. `ask_user({question,context?})` replaces `escalate`. It returns `{parked:true,instruction}`
   immediately, telling the agent to end its turn. The coordinator checkpoints and parks only
   after that turn ends. The answer is the next turn, not a blocked tool response.
5. Parking reads the negotiated `loadSession` capability. When supported, close and reap, then
   initialize a fresh process and `session/load` the same id with the same Team Bus configuration.
   Otherwise keep the idle session for `conversation.stop.keepAliveMinutes`, default 15. On
   expiry write a coordinator checkpoint from the last stored boundary and release without a
   model call. A review stop can still Continue, but can no longer Send back.
6. A late answer to a released agent question starts a new run from its checkpoint. The response
   is the new RunRecord and includes `x-loomwatch-continuation-of`; the UI opens that new run.
   It says this before submission. The previous run records the answer and closes as failed
   because its session was released. The continuation keeps follows/retry lineage and includes
   the answer as operator direction in its new task. Its deterministic start key prevents two
   concurrent submissions from creating two continuations.
7. `GET /api/runs/{id}` adds `replyableAgents` from the current live registry. The composer may
   put an operator reply to one of them through `POST /api/runs/{id}/agents/{agent}/ask {text}`.
   The existing serialized session queue prevents overlapping prompts. A gone session returns
   409 with `checkpointId` when available. `GET /api/runs/{id}/questions` exposes question history.
8. RunEvent kinds remain frozen. Additive `session_meta` phases bracket session-load replay and
   identify handover/checkpoint turns; see [WEBSOCKET_SCHEMA](../WEBSOCKET_SCHEMA.md). Replay
   bracketing is per agent. Checkpoint text and cost remain evidence but do not become Output.
9. Follow-ups replay both the structured handover and the separately recorded operator direction.
   Stops also record their inputs, allowing a later run to start at a review stop. A mixed live /
   replay DAG join is still refused as specified in ADR 0016. Start-key identity includes lineage.
10. Cancelling drops waiting/live channels and checkpoints interrupted work. A daemon restart marks
    interrupted records failed instead of pretending to restore their in-memory channels. Retry
    lineage is durable. Team mode requests an end checkpoint when its notebook is enabled.

All endpoints retain the loopback/origin checks of run control. These flows were exercised against
local fake harnesses; compatibility with each installed vendor's implementation of `session/load`
requires a separate live-provider run. No paid provider was used for this change.
