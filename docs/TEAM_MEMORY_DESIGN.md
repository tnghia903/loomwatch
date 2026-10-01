# Team context and memory

Status: proposal for discussion, not an implemented contract.
Date: 2026-09-12.

## Intended outcome

A team retains its goal, constraints, decisions, evidence and unfinished work across
delegations and long runs. Users can see and correct what the team remembers and inspect
the exact information supplied to an agent. Persistence reduces context loss; it does
not guarantee that a model attends to every supplied fact.

## Current implementation

- `src/lib.rs::run_pipeline_nodes` supplies the original goal and actual predecessor
  replies to downstream nodes. `agent_prompt` adds the configured role and capabilities.
- `src/team_bus.rs::run_agent_inner` starts delegated agents with their assigned task.
  The Team Bus already authenticates callers and implements structured tools.
- `src/archive.rs` persists ordered run events in Postgres. These records support
  inspection, but there is no shared memory selection or injection layer.
- `src/acp.rs` starts a session and waits for a `session/prompt` result. Its existing
  lifecycle does not provide a general coordinator-controlled compaction loop.
- `ui/src/components/run/HandoverPanel.tsx` exposes the predecessor text supplied to a
  stage. This is a natural starting point for a broader context inspector.

Backend paths above are relative to `crates/loomwatch-backend/`. This assessment uses
the current working files, including existing uncommitted changes.

## Product model

Use one team-level entry, **Context & memory**, with two everyday tabs:

| Tab | Contents | Default authority and lifetime |
| --- | --- | --- |
| Context | User-authored brief, constraints, reference notes and text/Markdown files | User-controlled; reusable by this team |
| Memory | Findings, decisions, known failures, open questions and progress | Agent-authored notes shared within this run; selected notes can be kept for future runs |

Checkpoints belong to the run's recovery controls. The event archive remains the full
record of what happened. Large outputs are immutable artifacts referenced from memory.
Avoid exposing all four storage concepts as separate destinations in the main navigation.

Default scope is the whole team for user context, and the current run for learned notes.
Allow a context item to apply to selected agents. Later, add per-agent working notes when
there is a demonstrated need. Do not introduce global cross-team recall by default.

Pinning means **always include in applicable future context packets**, within an explicit
budget. Keeping means **eligible for reuse in future runs**. These are separate actions.
An applicable pinned item that does not fit must produce an actionable error, not silent
omission. Agents cannot silently override user-authored context or pin their own advice.

## User experience

### Before a run

- Add a compact Context & memory action near team controls, with a contextual shortcut
  in the composer. Use the existing right-side panel pattern and existing theme tokens.
- Empty state: “Give your team context it should keep in mind.” Actions: Write a note
  and Add a text file. Begin with text/Markdown; add PDF ingestion separately.
- A note has a title, Markdown body, “Applies to: Whole team” and “Always include”.
  Advanced settings hold expiry and selection limits.
- Show a concise pre-run summary such as “3 shared notes · 2 saved memories”. Selecting
  it opens the sources and inclusion policy; it must not imply every saved item is injected.
- Preview per-agent planned context on request. Label it a preview: task-dependent
  selections can differ when later stages actually start.

### During a run

- The Memory tab shows compact titled notes, author, source, scope and status. Group by
  Decisions, Findings and Open questions only when those groups contain content.
- Agent notes are visibly attributed observations, not automatically verified facts.
  Conflicting versions can be compared and corrected without stopping unrelated work.
- Selecting an agent offers “Context supplied”: goal, applicable user notes, predecessor
  handover, selected memory and checkpoint. Explain why each item was included.
- Show “Supplied to Writer at 14:32”, not “Writer knows this”. Tool retrieval is labeled
  “Retrieved”; neither label claims the agent understood or followed the content.
- Keep the canvas focused on execution. Do not add a memory node or a line to every agent.
  Memory writes can appear as evidence in the existing activity experience.
- A user edit during a run says “Available at the next context refresh”. Show which agents
  still have an older revision. No promise of interrupting or rewriting an active turn.

### After a run and recovery

- Offer “Keep for future runs” for useful findings, with editable content and sources.
  Batch selection makes this optional review quick. User-created context already persists.
- Learned notes from failed runs remain available as run evidence; do not automatically
  promote them to team facts. Explicit scheduled-run promotion can be a later policy.
- Show checkpoint time, completed work and next action. Until executable recovery ships,
  label the action “Start a new run with this checkpoint”. A true Resume action requires
  durable scheduler state, dependency checks and side-effect reconciliation.
- “Remove from future context” disables recall but retains old run snapshots. A separate
  permanent-delete flow must state that removing archived bytes also limits replay.

Panel details follow existing opaque reading surfaces, keyboard focus restoration and
Escape behavior. Use text and icons alongside status colors, preserve the single primary
gold action, and replace the panel with a full-height sheet on narrow screens.

## Technical design

### Ownership and persistence

Add a daemon-owned MemoryService backed by the existing Postgres instance. Use one write
authority; agents access it through the Team Bus instead of concurrently editing a common
Markdown file. User context may refer to version-controlled Markdown; imported bytes are
snapshotted at run acceptance. Runtime notes live in Postgres. Export is explicit and
must not become a competing mutable source of truth.

Proposed logical records:

- `memory_spaces`: stable team memory identity and ownership. Require an unambiguous
  durable identity when memory is enabled; legacy team IDs can be empty. Renaming a team
  preserves identity; duplicating a team defaults to a separate memory space.
- `context_items` / `context_revisions`: title, exact content, source reference and hash,
  applicable agents, pin state, expiry and immutable revision history.
- `memory_items` / `memory_revisions`: space, optional run ID, kind, title, content, author,
  visibility, state, expiry, source references and any explicitly superseded revision.
- `context_packets`: run, invocation, agent, exact rendered text, selected revision IDs,
  selection rationale, estimator version, budget and content hash. Store before sending.
- `checkpoints`: run and invocation identity, completed steps, pending work, decisions,
  unresolved issues, artifact hashes and source event high-water mark.

All child references must remain inside the authorized space/run. Derive caller identity
and permissible scope from server-owned Team Bus session state, never caller-supplied IDs.
Use immutable revisions, optimistic concurrency for edits and idempotency keys for writes.
Do not resolve contradictory content by last-writer-wins. A revision conflict returns the
current version; semantic disagreements remain separate, attributed notes until resolved.
Commit mutations with their durable audit/outbox record in one transaction so a crash
cannot create invisible changes or a successful-looking event for a failed write.

### Agent tools

Proposed additions to the existing authenticated Team Bus:

| Tool | Behavior |
| --- | --- |
| `memory_search` | Search eligible notes within authorized scope; return bounded snippets and revision IDs |
| `memory_read` | Read an exact note revision or artifact excerpt, with bounded output |
| `memory_write` | Create a run-scoped note with kind and source references; retry-safe |
| `memory_update` | Revise an authorized note using an expected revision; preserve history |
| `checkpoint_save` | Save structured task state and evidence references |

User-facing APIs manage context, promotion, pinning, corrections, archive and packet
inspection. Agents cannot grant themselves broader visibility or rewrite user constraints.
Notes and fetched references are labeled source material, never elevated into privileged
instructions. Content cannot change tool permissions. Restrict imports to allowed paths
and snapshot bytes so later file edits cannot silently alter a recorded packet.

### Context assembly

Use one ContextAssembler for entrypoint, pipeline, delegated and restarted invocations:

1. Resolve the run's captured goal, team revision and applicable user-context revisions.
2. Add the assigned role/task and applicable pinned constraints.
3. Add predecessor handovers, or explicitly referenced delegation evidence.
4. Add the latest compatible checkpoint when continuing work.
5. Select relevant eligible notes within the remaining memory allowance.
6. Persist the exact packet, then supply it through the existing prompt path.

User context and cross-run memory have a run-start baseline. Explicit user amendments
create a recorded new baseline at the next managed boundary. Each invocation captures a
committed run-memory high-water mark. For pipelines, automatic injection uses ancestor
lineage plus explicitly published team decisions, avoiding dependencies on unrelated
branches' incidental execution order. Explicit searches can access the wider shared run
space and record exactly what they returned. Joins retain all actual predecessor inputs.

Start with scope/kind filters and Postgres text search, weighted toward explicit task
references, applicable decisions and relevant recent evidence. Recency alone is insufficient.
Add semantic retrieval only if retrieval evaluation demonstrates missed useful memories.

Set a separate configurable memory allowance, initially an estimated 4,000 tokens per
invocation as a tunable starting point. This is not the model's total available window.
Reserve room for task, tools, handovers and response; adapters may not expose an accurate
window size or live occupancy. Never display an invented “context full” percentage.
Oversized required input must pause with a clear remedy or use an explicitly enabled
artifact/excerpt handover mode. Do not silently truncate a predecessor reply and still
claim it was delivered verbatim.

### Long-run continuity

Persist successful stage outputs automatically, even if an agent never calls a memory
tool. Ask agents to save structured progress at milestones and before handoff. Save
checkpoint references after completed stages through the coordinator as well.

Optional summarization runs through a configured harness, preserving vendor neutrality
and existing credential ownership. Charge its cost to the run, bound its work, retain
sources, and validate its structured result. Summary failure preserves the previous
checkpoint and raw evidence. It must not make a completed stage look incomplete or lose
the only copy of a decision. Avoid repeatedly summarizing summaries without their sources.

Automatic packet injection is reliable at invocation boundaries. In an active harness
session, recall depends on memory tool calls or supported adapter hooks. General managed
refresh requires a continuation loop with bounded work units and explicit checkpoint/
continue state, rather than assuming every harness exposes compaction notifications.

Durable memory does not by itself resume processes. True recovery must persist scheduler
state, identify compatible code/workspace/artifacts, reconcile in-flight operations, and
avoid repeating completed external actions. Start with explicit new-run continuation.

### Replay and integration

Implement storage and selection in proposed `memory.rs` and `context.rs`; connect them
at `lib.rs` orchestration and `team_bus.rs` delegated startup. Extend the team schema only
with memory identity/policy and authored context references, not generated runtime notes.
Disabled memory preserves current behavior.

Use existing bus-authored tool call/update events for memory operations. Preserve the
frozen RunEvent envelope; packet metadata can live in dedicated tables and inspection
APIs. Any additional payload subtype requires an explicit schema decision. Reuse existing
stream events as invalidation hints with authoritative reads from the memory API.

Extend the handover inspector into a packet inspector while retaining a separate raw
predecessor view. Old runs keep their existing inspection experience. New replay loads
the stored packet and exact revisions, never a fresh search against today's memory.

## Delivery sequence

1. **Shared context:** note/file CRUD, scoped team identity, run-start snapshots, consistent
   injection on all invocation paths and per-agent context inspection.
2. **Run memory:** bounded search/read/write tools, source attribution, revision handling,
   team/run isolation and explicit keep-for-future-runs controls.
3. **Continuity:** structured checkpoints, automatic stage evidence capture, explicit
   new-run continuation and recovery UX. Add resumable execution only after scheduler
   durability and side-effect handling exist.
4. **Measured improvements:** optional summary automation, managed context refresh and
   semantic retrieval based on observed retrieval/recovery failures.

## Acceptance and evaluation

- A constraint appears in packets for entrypoint, downstream and delegated agents.
- A new session can recover an earlier decision and pending work using persisted state.
- A branch join retains both branches; unrelated branch order does not silently change
  automatically selected inputs. Later searches remain attributable.
- Concurrent edits cannot overwrite each other; retried tool writes do not duplicate notes.
- Another team/run cannot read restricted notes by guessing IDs or forging tool arguments.
- Editing/removing a note does not rewrite a historical packet; replay survives expiry.
- Required context overflow is explicit; summary failure and missing artifacts are visible.
- A memory-enabled run fails clearly on unavailable required storage instead of quietly
  starting without promised context. Editor-only operation can explain the dependency.
- Restart tests distinguish stored evidence from executable recovery and never blindly
  repeat a completed external action.
- UI labels distinguish saved, eligible, supplied and retrieved; keyboard and narrow-screen
  flows remain usable.

Use a scripted multi-stage task with an early constraint, a later correction, a conflict
and a fresh-session continuation. Compare with memory disabled for constraint retention,
retrieval coverage, stale/conflicting recall, task success, tokens and latency. Inspect
actual final behavior as well as packet inclusion; supplied text is not proof of adherence.

## Background

The proposed distinction between selective retrieval, structured notes and compaction is
consistent with Anthropic's discussion of long-horizon context management:
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

The architecture, defaults and UI above are LoomWatch design recommendations, not claims
that those features already exist or that the external source prescribes this design.
