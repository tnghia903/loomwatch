# Run/provenance contract fixtures

These examples are normative design vectors for
[`RUN_PROVENANCE_CONTRACT.md`](../../docs/RUN_PROVENANCE_CONTRACT.md).

| Case | Fixture |
|---|---|
| accepted start / null replay session | `start-run-request.json`, `start-run-response.json` |
| team-mode success | `run-summary-team-succeeded.json` |
| pipeline partial output / distinct per-process ACP sessions | `run-summary-partial.json` |
| same-key retry starts once | `duplicate-start-same-key.json` |
| same-key different fingerprint | `problem-idempotency-conflict.json` |
| stale byte revision | `problem-stale-team-revision.json` |
| multi-sink pipeline rejection | `problem-multiple-pipeline-sinks.json` |
| ordered REST replay | `event-replay-page.json` |
| WebSocket gap recovery | `reconnect-gap-vector.json`, `reconnect-replay-page.json` |
| exactly one frozen `RunEvent` WebSocket frame | `websocket-frame.json` |
| redaction and capture gaps | `provenance-snapshot.json` |
| SSE terminal upsert | `provenance-change.json`, `provenance-events.sse` |
| malformed evidence degrades coverage | `malformed-trace-observation.json` (intentionally invalid), `provenance-change-malformed-coverage.json` |
| explicit skill capture outside `RunEvent` | `trace-observation.json` |
| RFC 8785 source bytes and repeatable digests | `canonical-reprojection-vector.json` |
| byte-identical pinned-version graph replay | `provenance-snapshot.json`, `trace-reprojection-vector.json` |

Every JSON fixture except `malformed-trace-observation.json` must validate against its
named definition in `schemas/run-provenance.schema.yaml` or the frozen
`team.schema.yaml#/$defs/RunEvent`. The malformed observation must fail validation and must
produce partial coverage rather than disappearing or failing execution.
