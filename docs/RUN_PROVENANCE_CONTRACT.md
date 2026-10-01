# Run and provenance contract

Revision 1 · 2026-09-09 · **design contract for TNG-89B; no production implementation**

This document specifies the run control plane and the provenance companion channel for
the interactive canvas. It is normative for TNG-89C–F after Gate B. The machine-readable
shapes are in [`schemas/run-provenance.schema.yaml`](../schemas/run-provenance.schema.yaml),
and the transport decision is recorded in
[`ADR 0005`](decisions/0005-run-control-and-companion-provenance-channel.md).

The existing `RunEvent` contract remains frozen. Nothing here adds an event kind, adds a
field to a `RunEvent`, wraps a WebSocket frame, or changes archive order.

## 1. Normative language and identifiers

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

- `runId` is a LoomWatch UUID created before any ACP process or session exists.
- `archiveSessionId` is the run-bound replay/archive partition key copied into the frozen
  top-level `RunEvent.sessionId`. It is nullable until the first ACP session is negotiated,
  then compare-and-set exactly once onto the run.
- `acpSessionId` is the protocol session negotiated independently by one `AcpProcess`.
  A team run normally has several of these; it is never the cross-process replay key. For
  backward compatibility, `archiveSessionId` is seeded from the first process's
  `acpSessionId`, so those two values happen to match for that process only.
- `clientRequestId` is a client-generated UUID used for start idempotency.
- `seq` is the existing dense, zero-based, per-session `RunEvent` sequence.
- `cursor` is a separate dense, zero-based, per-run provenance-journal sequence. It has no
  relationship to `RunEvent.seq` and never appears in a `RunEvent`.
- A team revision is `sha256:` followed by the lowercase hexadecimal SHA-256 digest of the
  exact persisted YAML bytes. The JSON value is unquoted text; the HTTP strong ETag is the
  same value inside quotes.

All times are RFC 3339 UTC strings. IDs and cursors are opaque to clients except for the
ordering rules stated here.

## 2. Immutable team revision and snapshot

Successful `GET /api/team` and `PUT /api/team` responses add a `revision` field and the
equivalent strong `ETag` header:

```json
{
  "path": "research-team.yaml",
  "yaml": "schemaVersion: 1\n…",
  "revision": "sha256:4f2d8e51b3be927f387b5089cc80b09ad296de5a0efca0bd6e3e17cb721a1fb8"
}
```

An update to an existing file MUST carry `If-Match: "sha256:…"`; create MUST carry
`If-None-Match: *`. A missing precondition returns `428`, a mismatch returns `412`, and no
bytes are written. This closes the existing load/edit/save race independently of runs.

`POST /api/runs` carries `expectedTeamRevision`. Before accepting a run, the daemon MUST:

1. open the configured teams root as a directory capability, then traverse every
   `teamPath` component relative to that handle with `openat` + `O_NOFOLLOW` (or an
   equivalent capability API). Symlink components, non-regular final files, `..`, and any
   target not provably beneath the root are rejected as `422 unsafe_team_path`;
2. hold the final file and parent-directory handles, read one byte sequence from that open
   file, reject it above the snapshot limit, and hash those exact bytes;
3. compare the hash with `expectedTeamRevision` using exact string equality;
4. parse and semantically validate those same bytes; and
5. resolve every relative or absolute `spawn.cwd` through the same no-follow capability
   traversal beneath an authorized workspace root, and capture its canonical root-relative
   name plus stable platform identity (device/inode or equivalent); and
6. in one database transaction, persist the run, exact snapshot bytes (or an immutable
   content-addressed reference), original root-relative path, the captured team-base and cwd
   identities, digest, byte length, and idempotency record.

Only after that transaction commits may the supervisor enqueue execution. Execution MUST
parse and use the persisted snapshot and MUST NOT reopen the mutable team file. Relative
`spawn.cwd` semantics use the captured original team parent directory, but spawning uses the
captured authorized directory capability rather than resolving that pathname again.

The supervisor holds those directory capabilities through spawn. After daemon restart, it
may reconstruct them only by repeating anchored no-follow traversal, reauthorizing the run
principal, and matching the persisted platform identity before using a descriptor-relative
or descriptor-as-cwd spawn primitive. If a base/cwd was deleted, renamed beyond recovery,
or replaced at the same pathname, the run fails closed as `snapshot_base_unavailable` or
`snapshot_cwd_changed`; it never executes from the replacement. A renamed or deleted team
file itself does not affect a queued run because its bytes are already captured. Platforms
without a race-free directory-capability spawn MUST reject the run rather than fall back to
check-then-use path resolution.

A disk edit after acceptance therefore cannot change a queued or running run or escape its
authorized roots. Snapshot records are immutable and retained at least as long as any
referencing run.

The digest identifies bytes, not semantic YAML. Whitespace-only changes intentionally mint
a new revision. Content-addressed deduplication MAY share identical snapshot bytes, but it
MUST NOT merge run metadata or weaken authorization.

## 3. Run creation and lifecycle

### 3.1 Start

```http
POST /api/runs
Content-Type: application/json
Idempotency-Key: 30c35b8b-f29b-4ec1-9894-e833846db485
```

```json
{
  "teamPath": "research-team.yaml",
  "expectedTeamRevision": "sha256:4f2d8e51b3be927f387b5089cc80b09ad296de5a0efca0bd6e3e17cb721a1fb8",
  "prompt": "Compare the two migration strategies and recommend one.",
  "clientRequestId": "30c35b8b-f29b-4ec1-9894-e833846db485"
}
```

The `Idempotency-Key` header and `clientRequestId` MUST both be present and equal. A newly
accepted request returns `202` before ACP startup:

```json
{
  "runId": "01991f8a-7e39-7b86-8c37-0bd0e5b94e11",
  "clientRequestId": "30c35b8b-f29b-4ec1-9894-e833846db485",
  "status": "queued",
  "archiveSessionId": null,
  "teamRevision": "sha256:4f2d8e51b3be927f387b5089cc80b09ad296de5a0efca0bd6e3e17cb721a1fb8",
  "createdAt": "2026-09-09T03:00:00Z"
}
```

### 3.2 States

```text
                 normal completion ───────────────► succeeded
queued ─► starting ─► running ── abnormal + output ► partial
   │          │            └──── abnormal, no output ► failed
   │          └──────── startup failure ────────────► failed
   └────────── supervisor/archive failure ──────────► failed
```

`queued`, `starting`, and `running` are non-terminal. `succeeded`, `partial`, and `failed`
are terminal. Reconnecting is a client transport state, not a run state. Pause, resume,
mid-run steering, and cancellation are outside this contract and MUST NOT be inferred from
connection closure.

- `queued`: the immutable run transaction committed; no process has been claimed.
- `starting`: one supervisor owns the run and is starting the first configured agent.
- `running`: `archiveSessionId` is bound and at least one agent process is live or Team Bus
  work is outstanding.
- `succeeded`: the completion barrier closed normally and a non-empty canonical response
  was assembled.
- `partial`: canonical response content exists, but a process crashed, the canonical final
  turn ended abnormally, the archive/projector degraded, or another completion invariant
  failed.
- `failed`: the run reached a terminal failure without canonical response content.

Every transition is monotonic and persisted. A terminal state MUST NOT transition again.
At-least-once supervisor pickup uses an atomic `queued → starting` claim; a duplicate worker
cannot start a second process tree.

### 3.3 Run, replay-session, and ACP-session binding

The first ACP session created for the entrypoint (team mode) or first pipeline node
(pipeline mode) seeds `archiveSessionId`. Binding that replay key is compare-and-set from null;
a second replay-key value, or a key already owned by another run, is
`event_session_collision` and terminalizes the run.

Every process independently negotiates its own `acpSessionId`. The daemon records an
`AcpSessionBinding` keyed by `(runId, agentId, processAttempt)` with the actual protocol ID,
timestamps, and first/last `RunEvent.seq`. Reusing one protocol ID for two live processes in
the same run, or changing a process's protocol ID after negotiation, is
`acp_session_collision`. Downstream agents MUST NOT be required to reuse the first process's
ACP ID.

The shared `EventLog` stamps every participating agent's top-level `RunEvent.sessionId` with
`archiveSessionId`, preserving the existing one-partition archive and
`UNIQUE(session_id, seq)` rule. The unmodified `raw` frame retains that process's actual ACP
`params.sessionId`. `runId` remains the stable API identifier before, during, and after
either binding.

### 3.4 Completion barrier

Completion is derived without a new `RunEvent` kind. The barrier closes only when:

1. every agent for which a `process:spawned` event was observed has a later terminal
   `process:exited|crashed` event;
2. no authoritative Team Bus `dispatch` or `handoff` call remains outstanding;
3. pipeline mode has attempted every reachable configured node, or persisted why it could
   not; and
4. all accepted `RunEvent` writes and trace observations have been flushed.

An entrypoint `turn_end` alone never completes a team run. A client disconnect never
completes or cancels a run. Terminal metadata records the barrier facts, exit failures,
stop reason, and stable machine-readable error code.

## 4. Canonical response assembly

The canonical responder is fixed from the immutable snapshot:

- when the optional root `responder` is present, that configured agent;
- otherwise, the entrypoint in team mode or the unique terminal configured agent in pipeline mode.
  A team-mode `responder` must equal the entrypoint. A pipeline responder may be an earlier stage;
  later stages still execute, but their messages remain evidence rather than replacing the output.

For the canonical responder, partition its events into attempted turns. A normal turn ends
at that agent's `turn_end`; a crash/protocol failure ends the open turn at its terminal
process evidence or the persisted completion barrier. The canonical turn is the final
attempted turn, including an unterminated one. Its response is every `kind:"message"`,
`payload.role:"agent"` content block for that agent after its previous `turn_end` (or
session start) and before that boundary, ordered by global `seq`. This retains chunks emitted
before a mid-message crash. Other agents' messages are evidence only and MUST NOT be
concatenated into the answer.

`messageId`, when supplied, groups chunks for inspection but does not replace `seq` order.
Text blocks are concatenated without injecting text between adjacent chunks; non-text ACP
content blocks retain their order and are rendered only by an allowlisted renderer. The run
summary stores the ordered source event IDs, canonical source digest, pinned
assembly/sanitizer versions, and a sanitized assembled Markdown representation. The source
digest is SHA-256 over RFC 8785 canonical JSON of the ordered array
`[{eventId,seq,content}]`. The Markdown digest is SHA-256 over its UTF-8 bytes. Replay with
the pinned versions must reproduce both digests and bytes.

Normal completion requires `stopReason:"end_turn"`, successful process exits, a closed
barrier, and at least one non-empty renderable block. Content plus any abnormal condition is
`partial`. No content plus an abnormal condition or a normal turn with no response is
`failed` (`missing_canonical_response`). Partial content remains available.

## 5. REST contracts

All JSON responses use `application/json`. Errors use `application/problem+json` with
stable `code` values; representative fixtures live in
[`examples/run-provenance`](../examples/run-provenance/).

### `GET /api/runs/{runId}`

Returns the run state, immutable team reference, nullable replay-session binding, individual
ACP-session bindings, timing, canonical response, terminal summary, pinned projection
versions, and capture coverage. `canonicalResponse` and `terminal` are null until known.
Polling is safe and has no side effects.

### `GET /api/runs/{runId}/events?afterSeq=N&limit=L`

Returns the exact archived `RunEvent` objects in ascending `seq`. `afterSeq` is exclusive;
omitting it starts at zero. `limit` defaults to 200 and is at most 1,000. The page contains
`nextAfterSeq` (last returned `seq`, or the supplied value/null when empty) and `hasMore`.
Before replay-session binding, the response has `archiveSessionId:null` and an empty event
array. Each returned `RunEvent` still names that value in its frozen `sessionId` field.

This is a privileged evidence endpoint: returned objects are value-equivalent to the
archive, produce identical RFC 8785 canonical bytes, and validate against
`team.schema.yaml#/$defs/RunEvent`. It does not silently redact or reshape `raw`; doing so
would violate replay identity. See §9 for authorization.

### `GET /api/runs/{runId}/provenance`

Returns a deterministic, sanitized `TraceGraph` snapshot at `cursor`. Entities and edges
are sorted by the UTF-8 byte ordering of deterministic ID; evidence IDs are sorted by
`RunEvent.seq` then event ID. Sets represented as arrays are deduplicated before sorting.
Canonical bytes use RFC 8785 JSON Canonicalization Scheme (JCS), not schema/property order.
Reprojecting identical inputs with the pinned version tuple in §8.3 MUST produce
byte-equivalent JCS output.

### `GET /api/runs/{runId}/provenance/entities/{entityId}`

Returns bounded, sanitized details for an authorized trace entity. Restricted raw evidence
is never embedded. The response links evidence event IDs, which a separately privileged
client may resolve through the events endpoint.

## 6. Frozen WebSocket event stream

```http
GET /api/runs/{runId}/events?afterSeq=N
Upgrade: websocket
```

- The HTTP upgrade is authorized before `101 Switching Protocols`.
- After upgrade, the server replays archived events with `seq > afterSeq`, then tails live
  events.
- **Each text frame is exactly one JSON-serialized existing `RunEvent`.** There is no outer
  object, discriminator, run status, provenance cursor, heartbeat JSON, or batch frame.
- Frames use ascending, dense `seq`; live and replay frames have the same shape.
- Duplicate `(archiveSessionId, seq)` values (the frame fields remain `sessionId` and `seq`)
  are ignored. A gap causes the client to pause apply, recover through REST, then reconnect
  from the last contiguous `seq`.
- A terminal, flushed run closes with WebSocket code `1000`. Transport errors do not alter
  run state. The client reads terminal classification from the run resource or companion
  channel, never from an invented `RunEvent`.

This route intentionally reuses the REST path under WebSocket upgrade. A server MAY expose
an equivalent documented alias, but it MUST NOT change frames. The frozen proof is in §13.

## 7. Companion provenance SSE

```http
GET /api/runs/{runId}/provenance/events?afterCursor=C
Accept: text/event-stream
Last-Event-ID: C
```

The client first fetches a `TraceGraph`, then opens SSE after its cursor. Browser clients
authenticate with the same-origin secure, HttpOnly session cookie; non-browser clients may
use `Authorization`. Tokens MUST NOT appear in the URL.

Each data event is:

```text
id: 18
event: provenance
data: {"schemaVersion":1,"runId":"01991f8a-7e39-7b86-8c37-0bd0e5b94e11","cursor":18,"op":"upsert","resourceType":"entity","resource":{…}}

```

SSE comments MAY be used as keepalives. They carry no state. `afterCursor` and
`Last-Event-ID` are exclusive lower bounds; if both are present they MUST match. Changes are
idempotent upserts of an entity, edge, category coverage record, or projection run state.
The final run-state upsert marks a terminal status and final cursor; the server may then
close normally.

Consumers ignore a duplicate cursor. A gap triggers a new snapshot. If a cursor has been
compacted, the server returns `409 cursor_expired` before streaming and the client refetches
the snapshot. SSE is deliberately not multiplexed into the frozen WebSocket.

## 8. Trace and observation model

### 8.1 Deterministic graph

`TraceEntity.kind` is one of `prompt`, `response`, `agent`, `reasoning`, `skill`, `tool`,
`command`, or `source`. `TraceEdge.kind` is one of `initiated`, `participated`,
`delegated_to`, `reasoned_with`, `used_skill`, `invoked_tool`, `ran_command`,
`consulted_source`, `contributed_to`, or `derived_from`.

Entity IDs are deterministic within a run:

| Entity | ID material after `runId` |
|---|---|
| prompt / response | literal `prompt` / `response` |
| agent | immutable configured `agentId` |
| reasoning | source event ID, or message ID plus first `seq` |
| tool | authoritative `callId`; harness echo is linked, not duplicated |
| command | execute `callId` or observation external ID |
| source | SHA-256 of canonical source type + normalized reference |
| skill | canonical skill identity + version/path fingerprint |

Edge IDs are a hash of run ID, kind, from ID, and to ID. Re-observation upserts the same
entity/edge and adds evidence; it never invents a duplicate. Team Bus-authored pairs whose
title is `Team Bus: <tool>` are authoritative over harness echoes.

`capture` communicates epistemic quality:

- `recorded`: explicit protocol or adapter evidence;
- `derived`: deterministic relationship derived from recorded evidence;
- `redacted`: recorded evidence exists, but one or more public fields were removed or
  replaced by policy;
- `unavailable`: requested evidence was not emitted, unsupported, malformed, or dropped by
  a declared limit.

No inference from prose can label a skill, command, or source as used. Hidden
chain-of-thought is never requested. Only agent-emitted `thought` and `plan` artifacts may
be reasoning entities.

### 8.2 Separate observations

Facts absent from `RunEvent` are persisted as `TraceObservation` records, not synthetic
events. Each contains the run/agent, observation kind, stable adapter/external identity,
adapter version, observed time, sanitized normalized payload, redaction paths, and optional
evidence event IDs. The unique key `(runId, adapterId, externalId)` makes adapter retry
idempotent. Observation arrival gets the provenance cursor transactionally.

Capture adapters MUST report explicit facts only. A skill observation, for example, needs a
skill identity and version or path fingerprint plus an invocation/open event; merely finding
a skill in an agent prompt or filesystem is not use. Raw adapter payloads are not exposed
through provenance APIs and SHOULD NOT be persisted when normalized evidence is sufficient.

### 8.3 Canonicalization, normalization, and version pinning

Acceptance pins a `ProjectionVersions` tuple on the run: contract schema, response
assembler, projector, normalizer, redaction policy, and Markdown sanitizer versions. Capture
adapter IDs/versions are immutable fields of their observations. Replay MUST use the pinned
tuple; an upgrade creates a separately identified projection generation and MUST NOT
silently overwrite historical canonical bytes.

The complete deterministic input is: exact team snapshot bytes; `RunEvent`s in ascending
`seq`; observations sorted by adapter ID then external ID; the run-scoped provenance
identity key; and the pinned version tuple. `ts`/`observedAt` are output facts, never sort
keys. Duplicate evidence is removed by its declared idempotency key before projection.

Field normalization is versioned and deterministic:

- JSON output and digests use RFC 8785 JCS UTF-8 bytes. JSON numbers that cannot be
  represented by JCS are rejected as malformed evidence.
- Human text and response ContentBlocks preserve their JSON string scalar sequence; no
  locale-sensitive case folding, whitespace trimming, newline rewriting, or Unicode
  normalization is applied unless the field rule below says so.
- Agent/call/event IDs are opaque and preserved byte-for-byte. Skill identity is Unicode
  NFC of the adapter-supplied identity plus its exact version/path fingerprint.
- File/repository sources use the capture-time authorized root-relative path, `/`
  separators, no `.`/`..`, and case preserved. Replay never consults the current filesystem.
- URL sources lowercase scheme and ASCII host, remove a default port, remove dot segments,
  uppercase percent-escape hex, decode percent-encoded unreserved characters, preserve query
  pair order, and drop the fragment only when the adapter declares it non-semantic.
- A public source ID is a run-scoped HMAC-SHA-256 over source type plus the normalized
  restricted reference. The persisted per-run identity key is an immutable projector input
  and is never returned, preventing public IDs from becoming a credential/path oracle.
- Command argv remains an ordered string array; it is never reparsed as a shell command.
  Deterministic redaction runs before public command/source attributes are canonicalized.
- Entity/edge arrays and evidence IDs use the ordering rules in §5. Coverage categories use
  the fixed schema order only for presentation; JCS determines object-key bytes.

The pinned Markdown sanitizer disables raw HTML, allows only `http`, `https`, `mailto`, and
authorized LoomWatch-relative links, adds safe external-link attributes, and strips unsafe
nodes deterministically. Its version changes whenever parser, allowlist, escaping, or
truncation behavior changes. Redaction-policy or normalizer changes likewise require a new
version and projection generation.

## 9. Authorization and privacy

Host-header allowlisting is not authentication. Before run endpoints ship:

- every request MUST resolve an authenticated principal; a loopback-only deployment may
  map the local operator to one principal, but any non-loopback binding requires real
  authentication;
- start requires `runs:execute` plus read/execute access to the canonical team path;
- every process spawn rechecks the principal's workspace authorization and the persisted
  directory identity through the capability rules in §2;
- run metadata, events, WebSocket, provenance, and SSE require ownership or explicit
  `runs:read` grant for that run; exact raw events additionally require `runs:evidence`;
- unauthorized reads return `404` to avoid run-ID enumeration; unauthenticated requests
  return `401`; cookie-authenticated mutations require CSRF protection;
- authorization is rechecked on WebSocket/SSE upgrade and on long-lived-stream credential
  expiry. Revocation closes the stream;
- snapshot deduplication never grants access through another run's snapshot.

The default UI never renders `RunEvent.raw`. Every non-evidence run/provenance REST field and
every SSE resource is redacted before delivery, including run prompt, canonical-response,
error, and terminal metadata fields. Keys matching
secret/token/password/authorization/cookie patterns, all environment values, URI userinfo
and sensitive query values, and credential-like high-entropy strings are replaced with
`"[REDACTED]"`; redacted JSON paths and the pinned policy version are reported. Commands
expose sanitized argv, authorized cwd, exit status, and bounded output, never environment
values. Paths outside authorized roots become `"[PATH REDACTED]"`.

Redaction is fail closed: if classification fails, the field is withheld and coverage is
`partial`, never passed through. Markdown is untrusted: raw HTML is disabled, supported
links are scheme-allowlisted, and rendered content cannot execute scripts. The exact
RunEvent evidence endpoints remain a separately privileged exception because mutating their
values would break the frozen replay contract.

## 10. Limits

Limits are evaluated in UTF-8 bytes after HTTP decompression. Implementations may lower
configurable operational limits but MUST advertise them and use the same failure semantics.

| Surface | Contract limit | Behavior |
|---|---:|---|
| prompt | 65,536 bytes | `413 prompt_too_large`, no run/idempotency row |
| immutable team snapshot | 1,048,576 bytes | `413 team_snapshot_too_large`, no run |
| active runs | 4 per principal, 16 daemon-wide | `429 run_limit_reached` + `Retry-After` |
| replay page | default 200, max 1,000 events | clamp is forbidden; invalid `limit` is `400` |
| accepted ACP JSON-RPC frame | 8,388,608 bytes | fail run; never archive a truncated `raw` |
| public trace graph | 10,000 entities / 25,000 edges | retain evidence; coverage becomes partial with `projection_limit` |
| provenance change | 262,144 bytes | replace oversized details with bounded reference/redaction notice |
| entity detail response | 262,144 bytes | truncate at semantic field boundaries and declare truncation |
| canonical Markdown materialization | 4,194,304 bytes | retain event refs; paginate/reassemble full content from events |

Team-file guard and budget limits remain independent. A limit failure never masquerades as
complete capture.

## 11. Failure and replay rules

| Condition | Contract behavior |
|---|---|
| invalid JSON/schema | `400 invalid_request`; nothing starts |
| invalid team semantics | `422 invalid_team`; nothing starts |
| stale team digest | `409 stale_team_revision` with authorized current revision; nothing starts |
| idempotency key reused with different fingerprint | `409 idempotency_conflict`; original run unchanged |
| database unavailable before acceptance | `503 archive_unavailable`; nothing starts |
| failure after accepted run | persist terminal failure if possible; retain all prior output/evidence |
| ACP start/replay-session-bind failure | `failed`, stable error code, `archiveSessionId` may remain null |
| base/cwd renamed, deleted, replaced, or no longer authorized | fail closed before spawn; never resolve to a substitute |
| crash/abnormal stop with canonical content | `partial`, never discard content |
| malformed/unprojectable archived event | exact event remains replayable; graph skips it and coverage is partial |
| projector/capture-adapter failure | execution continues; graph/coverage declares degradation |
| WebSocket disconnect or gap | run continues; REST replay then reconnect |
| SSE gap/expired cursor | refetch deterministic graph snapshot |
| redaction failure | withhold affected public field; declare redaction/degradation |

Start idempotency is scoped to the authenticated principal. Its request fingerprint is
SHA-256 over RFC 8785 JCS of an object containing `teamPath`, `expectedTeamRevision`, and
`prompt` as their exact decoded JSON strings: no trimming, path normalization, newline
rewriting, or Unicode normalization occurs before hashing. Different decoded prompt, path,
or revision bytes conflict even if they later resolve to the same resource. Equivalent JSON
escape spellings decode to the same string and therefore match. The first successful
acceptance owns the key for the lifetime of the run record. A retry with the same key and
fingerprint returns the original start representation (`200` after the original `202`) and
MUST NOT enqueue again. Concurrent requests serialize through a unique constraint. Failures
before the run/idempotency transaction commits do not consume the key.

RunEvent replay deduplicates by `(archiveSessionId, seq)` (wire fields `sessionId`, `seq`) and
verifies event ID equality on a duplicate; a conflicting duplicate is corruption, not
last-write-wins. Provenance replay
deduplicates by `(runId, cursor)` and resource ID. Projection is deterministic from immutable
inputs; timestamps never determine ordering.

## 12. Capture-coverage matrix

Coverage is calculated for each run from explicit adapter capabilities and observed
evidence. `complete` means complete for the declared observable scope, never access to an
agent's private internal state.

| Category | Recorded evidence | Safe derivation | Complete only when | Unsupported / gap behavior |
|---|---|---|---|---|
| agents | immutable snapshot, `agentId`, process/session events, Team Bus calls | participation and delegation edges | every spawned agent has identity and terminal evidence | `partial`; unknown actor retained as unavailable placeholder |
| reasoning | agent-emitted `thought` and `plan` events | grouping by agent/turn | adapter declares all transport-exposed artifacts captured | `unavailable` when none emitted; never infer hidden reasoning |
| skills | explicit skill-runtime observation with identity + fingerprint + invocation | agent `used_skill` edge | adapter declares skill-use instrumentation and no observation gaps | `unavailable` without adapter; prompt/filesystem presence is not use |
| tools | `tool_call`/`tool_update`; Team Bus pair is authoritative | call lifecycle and agent edge | adapter declares all tool calls surfaced and every call is paired or terminally failed | `partial` for missing pair/opaque harness tools; echoes are deduped |
| commands | `toolKind:"execute"` with sanitized input/status, or explicit command observation | tool `ran_command` edge | execute instrumentation covers the run and each command has terminal status | `unavailable` if tool inputs are opaque; never parse prose as a command |
| sources | ACP `locations`, explicit read/search/fetch metadata, or source observation | normalized/deduped source identity and consulted edge | adapter declares supported source surfaces and all refs normalize | `partial`/`unavailable`; invalid or unauthorized refs are redacted |

Each category publishes `level: complete|partial|unavailable`, evidence basis, observed and
redacted counts, adapter IDs, and stable reason codes. A graph-level “complete” label is
allowed only when every requested category is complete; otherwise the UI says “partial
capture” and identifies the gaps.

## 13. Compatibility proof and implementation gate

The TNG-89B artifacts add only:

- this document;
- the separate `run-provenance.schema.yaml` contract and fixtures; and
- ADR 0005.

They do **not** modify:

1. `crates/loomwatch-backend/src/lib.rs::EventKind` — still exactly `message`, `thought`,
   `tool_call`, `tool_update`, `plan`, `permission`, `session_meta`, `usage`, `turn_end`,
   `process`;
2. `schemas/team.schema.yaml#/$defs/RunEvent` — still the same seven required fields plus
   optional `raw`, with the same kind enum;
3. `migrations/20260906000000_create_run_events.sql` — still the same ten-kind check and
   `UNIQUE(session_id, seq)`; or
4. `WEBSOCKET_SCHEMA.md` — still one unwrapped JSON `RunEvent` per text frame.

The provenance schema references the frozen `RunEvent`; it does not redefine it.
Provenance uses its own REST representation, journal cursor, and SSE connection. Production
implementation MUST NOT begin before Gate B and Code Reviewer sign-off on this contract,
schema, ADR, and fixtures.
