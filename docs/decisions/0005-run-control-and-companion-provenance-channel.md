# 0005 — Immutable run control and a companion provenance channel

- **Date:** 2026-09-09
- **Status:** Proposed — accepted for implementation only after Code Reviewer sign-off and Gate B
- **Decided by:** TNG-89 parent plan revision 2; specified by TNG-91
- **Reverses:** none

## Context

The interactive canvas needs a stable control-plane run ID before ACP creates a session,
race-free execution of the exact saved team definition, a canonical streamed response, and
an expandable graph covering agents, emitted reasoning artifacts, skills, tools, commands,
and sources.

The Phase-02/03 evidence boundary is already frozen:

- `EventKind` has ten variants;
- archive rows are unique and dense by `(session_id, seq)`;
- `RunEvent` has one fixed camelCase envelope and kind-selected payload; and
- each WebSocket text frame is one unwrapped serialized `RunEvent`.

That vocabulary records ACP and supervisor activity well, but it cannot honestly encode
all provenance. In particular, explicit skill-use capture needs adapter identity, version or
path fingerprint, redaction metadata, and a retry key. Adding those fields or a
`provenance` event kind would reopen the frozen contract and force every archive, replay,
WebSocket, and UI consumer to understand a second concern inside the execution stream.

Run creation also cannot use only a mutable team path. A queued run could otherwise execute
different YAML from the bytes the user reviewed and saved.

## Decision

1. **Run is a separate immutable control-plane record.** `runId` is created before ACP
   startup. Start validates an expected SHA-256 revision over exact team-file bytes,
   persists those bytes or an immutable content-addressed reference in the same transaction
   as the run and idempotency key, and executes only that snapshot. Relative working
   directories retain the original team-file directory as their semantic base. Team-file
   and cwd resolution use root-anchored no-follow directory capabilities; persisted
   directory identities are reauthorized and matched before every spawn. A renamed,
   deleted, or replaced base fails closed instead of executing a substitute.
2. **Team revisions use one canonical value in JSON and HTTP.** The body uses
   `sha256:<lowercase hex>` and the strong ETag quotes that same value. Conditional save and
   expected revision prevent save/start races.
3. **Run, replay-session, and ACP protocol IDs remain distinct.** `runId` exists while
   queued. `archiveSessionId` binds once and is the shared archive/replay key copied into the
   frozen top-level `RunEvent.sessionId`; for compatibility it is seeded from the first
   process's ACP session ID. Every process independently negotiates and records its own
   `acpSessionId`, which remains visible in its raw protocol frames. Downstream processes do
   not reuse the first protocol session. Collision/CAS rules are separate for both identity
   classes.
4. **The frozen WebSocket remains execution evidence only.** Live and replay text frames
   are exact, unwrapped `RunEvent` objects. No status envelope, provenance object, cursor,
   heartbeat JSON, or terminal event is added. Completion remains derived from terminal
   process events plus drained Team Bus work; terminal classification lives on the run
   resource.
5. **Normalized provenance is a companion projection.** A deterministic projector consumes
   the immutable snapshot and archived `RunEvent`s. Explicit facts unavailable from
   `RunEvent` arrive as separately persisted, retry-safe `TraceObservation`s. REST serves a
   sanitized graph snapshot and bounded entity details; SSE serves idempotent graph,
   coverage, and projection-state upserts on a separate per-run cursor.
6. **Evidence quality is part of the public model.** Every entity and category declares
   recorded, derived, redacted, or unavailable evidence and stable coverage reasons. Skill,
   command, source, and reasoning use is never inferred from prose. Private hidden
   chain-of-thought is never requested or represented.
7. **Exact events and public provenance have different privacy contracts.** Exact
   RunEvent REST/WebSocket access requires the stronger `runs:evidence` authorization and
   is not silently mutated. Default provenance/SSE/detail surfaces are redacted before
   delivery, fail closed, and never embed restricted raw evidence. Host allowlisting alone
   is not authentication; non-loopback run endpoints require an authenticated principal.
8. **Start and replay are idempotent.** Start keys are unique per principal and bind to a
   canonical request fingerprint. Event replay deduplicates by `(archiveSessionId, seq)`
   (the frozen wire names these `sessionId` and `seq`); provenance replay uses
   `(runId, cursor)` and deterministic resource ID. Connection loss never restarts or
   cancels a run.
9. **Projection bytes are explicitly canonical and versioned.** Graphs and response-source
   digests use RFC 8785 JCS. Run acceptance pins assembler, projector, normalizer, redaction,
   and Markdown-sanitizer versions. Source/path/URL/skill normalization and array ordering
   are normative; a version change creates a new projection generation rather than silently
   rewriting historical bytes.

The normative lifecycle, response assembler, route behavior, redaction policy, limits,
coverage matrix, and failure semantics are in
[`RUN_PROVENANCE_CONTRACT.md`](../RUN_PROVENANCE_CONTRACT.md). Machine-readable shapes and
fixtures are in [`run-provenance.schema.yaml`](../../schemas/run-provenance.schema.yaml) and
[`examples/run-provenance`](../../examples/run-provenance/).

## Consequences

- Existing archive rows, schema validators, CLI output, replay readers, and WebSocket
  consumers remain compatible. TNG-89 adds zero `RunEvent` kinds and zero frame fields.
- The UI uses two ordered channels for different jobs: `RunEvent.seq` for exact execution
  evidence and provenance `cursor` for a rebuildable, redacted graph. It must independently
  recover gaps on each.
- A run can be created and displayed while `archiveSessionId` is null. ACP startup failure
  still has a durable run and diagnosable terminal state. A multi-agent run retains each
  process's distinct ACP session identity without disturbing its one dense event stream.
- The canonical answer is deterministic and does not concatenate helper chatter. Partial
  output survives crashes and abnormal stop reasons.
- The projector and capture adapters can evolve by version without reopening the execution
  event contract. Reprojection remains testable from immutable inputs.
- The exact evidence stream cannot be made safe for a lower-privilege audience by silently
  redacting fields; such an audience must use the companion projection or a future distinct
  sanitized contract.
- Storage grows for immutable snapshots, run records, observations, and the provenance
  journal. Content-addressed snapshot deduplication and journal compaction are allowed only
  when run authorization and cursor-expiry behavior remain intact.

## Alternatives rejected

### Add provenance variants to `RunEvent`

Rejected because it changes the frozen kind enum and forces execution consumers to parse a
new concern. It also cannot represent projector revisions and redaction/coverage cleanly
without more envelope drift.

### Wrap WebSocket frames in `{runId, type, data}`

Rejected because it breaks the explicit one-frame/one-`RunEvent` Phase-03 contract and
makes archived and live events distinguishable.

### Encode provenance in existing `session_meta` or `tool_*` payloads

Rejected because it abuses routing hints, weakens kind-specific meaning, and makes skill or
source claims look like ACP evidence when they came from an adapter or derivation.

### Build provenance only in the browser

Rejected because clients would implement divergent inference and redaction, could not
capture explicit adapter observations, and could not guarantee replay-equivalent graphs.

### Poll provenance snapshots only

Viable as a fallback, but rejected as the primary live experience because large graph
snapshots would be repeatedly transferred and the UI could not apply fine-grained,
idempotent live updates. SSE is one-way, reconnectable, and appropriate for server-produced
projection updates; command/control remains REST.

### Use the mutable team path at worker pickup

Rejected because it violates reviewability and replay: a queued run could execute a later
edit while still claiming the earlier user action.

## Review gate

This ADR remains **Proposed** until the designated Code Reviewer verifies the frozen-event
proof, snapshot integrity, idempotency, replay determinism, authorization split, redaction
failure behavior, and representative fixtures. Gate B must also be accepted before any
production implementation uses these contracts.
