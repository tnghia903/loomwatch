# Team memory

Revision 3 · 2026-09-13 · design settled; memory phases 1–3, Canvas A, Canvas B and the runs table built

This is the Markdown form of the settled design proposal "A team that cannot remember is not yet a
team." It supersedes the untracked draft `docs/TEAM_MEMORY_DESIGN.md`, which is kept because it is
the record of how the design got here. The schema change and the storage decisions have their own
ADR: [0014](decisions/0014-team-memory-brief-and-packets.md).

**[Implementation status](#implementation-status) is at the bottom and is kept current.** Read it
before trusting any sentence here as a description of the tree.

---

## 1. What the team forgets

Four losses, each a line in the tree rather than a hypothesis.

| Loss | Where | What an agent actually receives |
|---|---|---|
| Delegated helpers start blind | `team_bus.rs::run_agent_inner` | Its `role`, its wired skills, and the one string its caller typed into `dispatch`/`ask`. No goal, no constraints, no findings so far. It also skipped `workspace::materialise`, so it got no delivered capabilities either. |
| Pipeline stages only see one hop back | `lib.rs::run_pipeline_nodes` | The original prompt plus the handover its direct predecessor wrote. Stage 3 never sees what stage 1 decided unless stage 2 restated it. |
| Nothing survives the run | `migrations/`, `runs.rs` | The only table was append-only `run_events`; the run registry is in memory. |
| Long sessions compact invisibly | `acp.rs::record_frame` | The harness compacts its own window; ACP reports nothing LoomWatch can act on. |

Two existing mechanisms point the way and are reused rather than duplicated. ADR 0013 stopped
pasting transcripts between stages and instead asks the producing stage, in its still-warm
session, to write a structured handover — a second `prompt_turn` on a live session. That is the
same primitive a checkpoint needs and the same primitive an operator's follow-up needs. And the
Team Bus already holds server-owned delegation lineage per token, which is exactly the scope a
helper's memory should be selected from.

## 2. Three things, three lifetimes

The whole feature is one panel called **Memory**, holding three kinds of entry that differ only in
who writes them and how long they last.

| Entry | Written by | Lives | Reaches an agent | Example |
|---|---|---|---|---|
| **Brief** | The operator | With the team, across runs. Markdown beside the team YAML. | Always, at every start, within a budget. If it does not fit, the run refuses to start and says why. | "We ship on ACP v1 only. British spelling. Never touch `main`." |
| **Notebook** | Agents, during a run | With the run. Any entry can be **kept** so the next run sees it. | Selected at start by lineage and kind; searchable mid-turn through Team Bus tools. | "Decision · Researcher: the Hermes adapter is out of scope, its auth is broken on this machine." |
| **Checkpoint** | Each agent, at boundaries | With the run, one per agent per boundary. | Only when continuing work that stopped. | "Done: sections 1–3 drafted. Next: section 4. Blocked on: pricing table." |

**Two verbs, kept separate.** **Pin** means "always include this in future packets, within the
budget" and applies to Brief entries by default. **Keep** means "let future runs find this" and is
the only way a Notebook entry outlives its run. Agents can write to the Notebook but can never
pin, never edit the Brief, and never widen their own scope.

Naming: the panel is **Memory**; its tabs are **Brief** and **Notebook**. The backend's internal
map of what each stage handed forward is `handovers`, never `briefs` — see ADR 0014 §6.

## 3. How memory reaches an agent

Four channels, and the design is explicit about which one carries what.

### Channel 1 — the context packet (session start, every harness)

A section, `## What the team knows`, rendered into the prompt after the role and before the task.
Brief first, then selected Notebook entries, then a checkpoint if continuing. **The exact rendered
text is stored before it is sent**, so the UI shows what was supplied rather than re-parsing a
prompt.

Deterministic, and it reaches all three call sites (team mode, every pipeline stage, every
delegated helper). Its one weakness: it is not visible after the harness compacts.

### Channel 2 — the harness's own memory file (session start, managed workspaces)

Every supported harness reads a project memory file from its working directory: `CLAUDE.md`,
`AGENTS.md`, `GEMINI.md`. `workspace::materialise` already builds a per-agent directory, so
writing the Brief there as the harness-native file means the harness reloads it into its own
system prompt — the one place a compaction does not reach, with zero protocol work.

The cost: it only applies when the agent runs in the managed workspace. `deliverAs: native-file`
is the default and moves the agent there, exactly as wiring a skill already does. An agent that
must run inside a repository declares `deliverAs: packet-only`, keeps its `cwd`, and the panel
says its Brief will not survive compaction.

Which file each harness reads (verified on this machine, see ADR 0014 §3):

| Harness | File |
|---|---|
| Claude (`claude-agent-acp`) | `CLAUDE.md` |
| Gemini (`gemini --acp`) | `GEMINI.md` |
| Codex, OpenCode, OpenClaw, Hermes, pi | `AGENTS.md` |
| anything LoomWatch does not recognise | none — packet only |

### Channel 3 — Team Bus memory tools (mid-turn, any harness with HTTP MCP)

`memory_search`, `memory_read`, `memory_write` and `checkpoint` join the delegation tools already
injected through `session/new`. The bearer token identifies the author and bounds what it can see;
the agent never names itself. Every call archives as the existing `tool_call`/`tool_update` pair,
so memory writes appear as evidence in the run story for free.

Works during a long turn and needs no new event kinds. Depends on the model choosing to call.

### Channel 4 — checkpoint, then continue (boundaries, long runs and recovery)

At the end of each pipeline stage the coordinator already asks for a handover in the warm session.
Ask for a structured checkpoint the same way, and also on demand. Continuation is a **new run**
whose packet opens with the latest checkpoint, labelled "Start a new run from this checkpoint",
never "Resume", until scheduler state and side-effect reconciliation exist.

## 4. The Memory panel

Memory gets no node and no edge to every agent. It appears in three places the operator already
looks.

**Before a run.** The composer gains one chip, beside the mode chip, because both explain what the
run will be made of. The count is honest about state: *2 brief* are pinned and will be supplied;
*5 kept* are eligible, not promised. The panel is opaque (`e2`) because the operator reads it
carefully. Empty state: "Give your team something to keep in mind." with **Write a note** and
**Add a file**. Note files live under the team directory and are bounded by it. A note written in
the panel is saved as `<team>.brief/<first-words>.md` beside the team file, so two teams kept in
the same folder never write to the same note file. The entry joins the team when the team is
saved; until then the panel lists it under **Not saved yet** with a **Save team** button.

**During a run.** The Notebook is a feed the operator can correct without stopping anything.
Groups appear only when they have content. A corrected entry keeps its history; a retired one
stays visible and dimmed. Editing the Brief mid-run never claims to interrupt a live turn: a strip
says exactly when the change lands and who still holds the old revision.

**What an agent was given.** The existing handover panel is the packet inspector: each section
with its character count and the reason it was selected — or excluded — plus the Brief file path
and content hash it came from. It reads the stored record, not the prose.

### Copy and label rules

- **Supplied**, **retrieved**, **kept**, **eligible** are the four words. Never "the agent knows",
  "remembers", or "has read".
- Every agent-written entry carries author, time and source. Corrections say who corrected and
  when. Nothing is silently overwritten.
- Budget copy names **characters**, matching `conversation.brief.summaryChars`. No invented
  "context 63% full" meter: adapters do not report live occupancy.
- Narrow screens: the panel becomes a full-height sheet, the same treatment the Library has.

## 5. Configuration

```yaml
memory:
  enabled: true                          # explicit off switch; false == no block at all
  brief:
    - path: brief/constraints.md         # whole team, always included
    - path: brief/tone.md
      appliesTo: [writer]                # optional; default is every agent
  packet:
    maxChars: 8000                       # memory's share of an opening prompt
  deliverAs: native-file                 # default; packet-only per agent for repo cwds

agents:
  - id: writer
    # …
    memory:
      brief: true                        # default; false opts this agent out entirely
      deliverAs: packet-only             # keeps this agent in its declared cwd
```

A worked example ships as [`examples/team-memory.yaml`](../examples/team-memory.yaml) with its
Brief in `examples/team-memory.brief/`. It is loaded from disk by a test, so a wrong path there is
a failing gate rather than a broken example.

Rules the loader enforces beyond the schema:

- Brief paths are relative to the team file, and must resolve — symlinks followed — under the
  team file's own directory. Absolute paths and escapes are refused, naming the entry.
- A Brief file that is missing, unreadable, or not valid UTF-8 refuses the run. It is never
  skipped: a Brief that silently did not load is worse than one that fails loudly.
- The whole Brief is read **once**, at run acceptance, before anything spawns. Every stage and
  every delegated helper in one run is supplied the same bytes even if the operator saves a file
  mid-run — which is what lets the panel say truthfully who still holds the old revision.
- Pinned content exceeding `packet.maxChars` for any agent refuses the run, naming the entries and
  the overage.
- The team's `id` is the memory scope: renaming a team keeps its memory, and a duplicated file with
  the same id shares it, which the panel states rather than hides.

## 6. Storage

| Table | Holds | Notes |
|---|---|---|
| `context_packets` | run id, agent id, invocation, rendered text, sections with rationale, Brief paths and hashes, budget used | Stored before `session/prompt`. Replay and follow-ups read this, never a fresh search against today's memory. |
| `memory_notes` | team id, run id (null once kept), author agent, kind, title, body, sources, state, revision, supersedes | Immutable revisions; a correction inserts a new revision superseding the old. Optimistic concurrency on `revision`; idempotency key on tool writes. |
| `checkpoints` | run id, agent id, invocation, done, next, blockers, artifact paths and hashes, archive `seq` high-water mark | Written at stage end, on park, and by the `checkpoint` tool. |
| `runs` | everything `RunRecord` holds in memory, plus `followsRunId`, `startAt`, `waitingOn` | Its own ADR. Run lineage, follow-ups and parked questions must survive a restart. |
| `operator_questions` | run id, node or agent id, question, asked at, answered at, answer event id | The queue behind "waiting for you". One open question per agent at a time. |

`run_events` is untouched. Memory tool calls archive as the bus's existing `tool_call`/`tool_update`
events; operator answers archive as user `message` events from the operator node's id. Packet
metadata and questions travel over REST, so the frozen WebSocket schema stays frozen — see
[WEBSOCKET_SCHEMA.md](WEBSOCKET_SCHEMA.md) §3 for the two additive `session_meta` subtypes.

## 7. API

| Route | Purpose |
|---|---|
| `GET /api/memory?path=` | The team's Brief: entries, scopes, budget, `deliverAs`. A team with no block reports an honest nothing; an unreadable Brief is a 422 naming the entry. |
| `PUT /api/memory/file` | Write one Brief Markdown file beside the team YAML. `{path, file, body}`. Bounded to the team's own directory. The `memory.brief` line is a team-file edit and goes through the UI's document model instead. |
| `GET /api/runs/{id}/context?agent=` | The stored packets with sections and rationale, for the inspector. |
| `POST /api/runs` | Gains `followsRunId`, `startAt` and `fromCheckpointId`. Earlier stages replay their handovers from the archived `prompt_sections` record — `context_packets` holds the memory packet, not the handover (ADR 0016 decision 7). |
| `GET /api/runs/{id}/checkpoints?agent=` | Where each of a run's stages stopped, for the strip that offers to continue from one. |
| `POST /api/runs/{id}/answers` | Answer a review stop or an `ask_user`: `{node, text, sendBack?}`. |
| `POST /api/runs/{id}/agents/{agent}/ask` | Operator follow-up to a kept-alive agent; 409 when released, with the checkpoint id. |
| `GET/PUT /api/memory` notebook half | Keep/correct/retire, inherited view. |
| `POST /api/memory/packs`, `GET /api/memory/packs/{id}` | Export and import packs. |

## 8. Selection: lineage first, search second

1. **Brief** entries (own, then inherited) whose `appliesTo` includes the agent, in file order. If
   pinned content alone exceeds `packet.maxChars`, refuse to start with the entry names and the
   overage.
2. **Checkpoint**, only when the run was started from one or continues a parked question.
3. **Direction from you**, when a review stop or answer precedes this stage.
4. **Notebook**, from the remaining allowance: every *decision* in the run, then entries authored
   by the agent's lineage — configured ancestors for a pipeline node, the server-owned
   `delegation_path` on its bus token for a delegated helper. Inherited kept notes rank after the
   run's own. Unrelated branches are reachable by search, never injected by accident of run order.
5. Ranking within a kind is by explicit citation from the handover, then recency. Postgres
   full-text search serves `memory_search`. No embeddings until a retrieval evaluation shows
   misses that text search cannot fix.

## 9. Trust boundary

- Notes and handovers render as **source material, not instructions**. Only the operator's own
  text renders as direction, under `## Direction from you`. Content in a note can never change
  tool permissions, the Brief, or another team's memory.
- Author identity and visible scope derive from the bus token's `AgentSession`. Every id an agent
  passes is checked against that scope; a guessed id from another team or run reads as not found.
  Inherited scopes are read-only by construction.
- Brief files and packs are read only from under the teams root, with the same symlink and escape
  rules the root already enforces. Bytes are snapshotted at run start.
- Mutations commit with their audit row in one transaction, so a crash cannot produce a note the
  UI shows but the packet never contained, or the reverse.

## 10. Delivery sequence

| Step | What |
|---|---|
| **Memory 1 — Brief** | `MemoryConfig` and the schema block; `## What the team knows` in the prompt; `materialise` writes the harness-native file; `run_agent_inner` calls `materialise` and receives the packet; packets persisted and served; composer chip, Brief tab, packet inspector; `events.ts` stops parsing prompt templates; `briefs` → `handovers`. |
| **Canvas A — one canvas** | Retire `storyLayout` and `runPositions`; dock the Prompt and Output nodes; evidence folds to a count and fans for one agent; the run chip replaces the view switch. **Built 2026-09-13** against the written §12 revision — [TNG89_INTERACTION.md §15](TNG89_INTERACTION.md#15-team-memory-revision--one-canvas-for-designing-and-watching) — *without* the board pass on the default `canvas` screen that decision 6 made a precondition: the operator decided to build now and record the decision instead. See §15's status line. |
| **Memory 2 — Notebook** | `memory_notes`; a `memory.rs` write authority; the four bus tools; lineage selection; Keep/Correct/Retire; memory writes as evidence. Inherit and packs ride here. **Built 2026-09-13** — see the ledger below. |
| **Runs table** | Move `RunRegistry` to Postgres with `followsRunId`, `startAt`, `waitingOn`. Its own ADR. **Built 2026-09-13** ([ADR 0015](decisions/0015-runs-table.md)); the three lineage fields are columns and record fields with no `POST /api/runs` behaviour yet. |
| **Canvas B — follow-ups** | Permanent Prompt node mirrors the composer; `POST /api/runs` gains `followsRunId`/`startAt`; earlier stages replay from stored packets; history as a thread. **Built 2026-09-13** ([ADR 0016](decisions/0016-sidecar-v2-followups-and-checkpoints.md)) — the replay reads the archived *prompt record*, not `context_packets`; see the ledger. |
| **Memory 3 — checkpoints** | A checkpoint turn at every stage boundary using ADR 0013's primitive; the `checkpoint` tool; "Start a new run from this checkpoint". **Built 2026-09-13** (ADR 0016), at the cost of one more turn per stage. |
| **Canvas C — stops and questions** | `kind: operator`; the coordinator pauses on an operator node; `ask_user` parks and resumes; `POST /api/runs/{id}/answers`; "You" in the Library; gold waiting state. |
| **Memory 4 — measured** | Only with evidence: summarisation, a managed refresh loop, semantic retrieval. |

## 11. What keeps it fast

- **Bounded prompts.** A fixed character budget, so opening prompts do not grow with the age of
  the team. Pinned overflow fails before a harness spawns.
- **No idle processes.** Parked agents reload with `session/load` wherever the harness allows it;
  kept-alive sessions have a short bound everywhere else.
- **No re-execution.** Follow-ups replay stored handovers and packets; only stages after `startAt`
  run. Retry stays the explicit "from zero" action.
- **Local text search.** Postgres full-text search over a few thousand notes answers in
  milliseconds and needs no embedding service.
- **One event stream.** Memory and question updates ride the existing WebSocket as invalidation
  hints and are read back over REST.
- **A stable canvas.** Configured positions never change on run open, so React Flow reconciles
  runtime facts onto existing nodes instead of rebuilding the graph.

---

## Implementation status

Kept current. Last updated 2026-09-13 (memory phase 3 — checkpoints — Canvas B's follow-ups, the
canvas half of memory wiring, and persisted node positions:
[ADR 0016](decisions/0016-sidecar-v2-followups-and-checkpoints.md)).

### Built and gated

| Piece | Where | Gate |
|---|---|---|
| `memory:` block in the schema, with `$defs/Memory`, `BriefEntry`, `Packet`, `AgentMemory` | `schemas/team.schema.yaml` | `cargo test --test team_schema` |
| `MemoryConfig`, `BriefEntryConfig`, `PacketConfig`, `DeliverAs`, `AgentMemoryConfig`; `AgentConfig::reads_brief`/`deliver_as` | `config.rs` | compiled, exercised by every memory test |
| Brief loading with the teams-root boundary, symlink escape refusal, UTF-8 and missing-file refusals, titles from headings | `memory.rs::TeamMemory::load` | `memory::tests::*` (9 tests) |
| Packet rendering, `appliesTo` scoping, recorded exclusions, oversize refusal naming the entry | `memory.rs::packet_for` | `memory::tests::*` |
| **An oversized pinned Brief refuses the run before any harness spawns**, including when the overflowing entry is scoped to a later stage | `lib.rs::run_loaded_team` | `tests::an_oversized_brief_scoped_to_a_later_stage_refuses_the_whole_run` (counterfactual verified) |
| `## What the team knows` after the role, before the task; byte-identical prompt without a `memory:` block | `lib.rs::compose_prompt` | `tests::a_team_without_memory_gets_exactly_the_prompt_it_got_before` |
| Harness-native memory file written into the managed workspace; `packet-only` opt-out; unknown harness gets no file | `workspace.rs` | `workspace::tests::a_native_file_brief_…`, `each_harness_gets_the_memory_file_it_actually_reads`, `packet_only_keeps_the_agent_in_its_own_directory` |
| **A delegated helper is supplied the Brief, and goes through `materialise`** | `team_bus.rs::run_agent_inner` | `team_bus::tests::a_delegated_helper_is_supplied_the_team_brief` (counterfactual verified) |
| **A constraint written once reaches the entrypoint and a downstream stage** | `lib.rs::run_pipeline_nodes` | `tests::a_constraint_written_once_reaches_the_entrypoint_and_a_downstream_stage` (counterfactual verified) |
| `context_packets` table, store-before-prompt, `GET /api/runs/{id}/context?agent=` | `migrations/20260913000000_create_context_packets.sql`, `archive.rs`, `runs.rs` | asserted inside the acceptance test |
| `session_meta` `context_packet` and `prompt_sections` archived before the prompt | `acp.rs::start_recorder` | asserted inside the acceptance test |
| `events.ts` reads the prompt record instead of splitting prose | `ui/src/lib/watch/events.ts` | `events.test.ts` "reads the prompt parts from the daemon record…" (contains its own counterfactual) |
| `GET /api/memory`, `PUT /api/memory/file` with the team-directory boundary | `api.rs` | `api::tests::memory_endpoint_*`, `writing_a_brief_file_*` |
| Composer Memory chip; Memory panel (Brief tab, e2, Write a note / Add a file); packet inspector | `composer/Composer.tsx`, `memory/MemoryPanel.tsx`, `run/HandoverPanel.tsx` | `Composer.test.tsx`, `MemoryPanel.test.tsx`, `HandoverPanel.test.tsx` |
| `memory.brief` editing in the byte-preserving document model | `ui/src/lib/team-file/document.ts`, `useTeamDocument.ts` | `team-file.test.ts` "memory.brief editing" |
| `briefs` → `handovers`, `brief_request` → `handover_request` | `lib.rs` | compiled; existing pipeline tests unchanged |

### Canvas A — one canvas (built 2026-09-13, no board pass)

Built against [TNG89_INTERACTION.md §15](TNG89_INTERACTION.md#15-team-memory-revision--one-canvas-for-designing-and-watching).
Decision 6 made a board review on the default `canvas` screen a precondition; the operator decided
to build now and record the decision instead, so **that review did not happen.** Nothing in the
build is Rust: `cargo test -p loomwatch-backend` (159) and `cargo clippy -- -D warnings` were run
to prove it.

| Piece | Where | Gate |
|---|---|---|
| `storyLayout` and `runPositions` **retired**. Agents render at `doc.nodes` positions in every state; one graph builder, not a compose branch and a run branch | `ui/src/lib/runs/runOverlay.ts` (new), `Workspace.tsx` | `Workspace.test.tsx` "opens a run without moving a single configured node (row 40)" (counterfactual verified) |
| Prompt and Output **permanent and docked** — Prompt at `entrypoint.x − 340` with the `Run NN` card under it and the schedule card above it; Output at `terminal.x + 340`, dashed with "The team's answer appears here when *stage* replies." until it has content, streaming in place | `runOverlay.dockAnchors`, `run/StoryNodes.tsx` | `runOverlay.test.ts` (4), `Workspace.test.tsx` "docks the Prompt first and the Output last (rows 23, 24, 42)", `OutputNodeCard.test.tsx` (2) — all counterfactual verified |
| The Prompt node before a run **is** the composer's draft: text mirrors in as the operator types, a click focuses the composer, no second editor | `StoryNodes.PromptNodeCard`, `Workspace.focusComposer` | `Workspace.test.tsx` "is a draft before a run…" (counterfactual verified) |
| **Evidence folds to a count and fans one agent at a time**; opening another folds the first; `visibleEvidence`'s `+N more` folding kept; Esc folds before it clears the run; the provenance panel and the Library reveal fan the owner | `BuildNodeCard` event-count chip, `runOverlay.fanEvidence`, `Workspace` `fannedAgentId` | `Workspace.test.tsx` "fans one agent at a time, folding the other, and keeps every card exact (row 43)", `BuildNodeCard.test.tsx` (2) — counterfactual verified |
| **The run chip replaces the view switch.** The lifecycle strip *is* the chip: attempt, phase, elapsed, live/replay, ← →, `Clear`. No `compose-view`/`run-view` pair, no "Back to the team canvas"; the one remaining shell class is `run-shown` | `run/LifecycleStrip.tsx`, `Workspace` shell class and ⌘K | `Workspace.test.tsx` "returns to the design alone through the run chip, with no view switch left (row 44)" (counterfactual verified) |
| **Editing is never locked while a run is shown**: drag, rename, connect, delete, auto-layout, Library drop, capability placement and the Inspector all behave exactly as they do outside a run | `Workspace` (every `!runView` editing gate removed), `canvas/Inspector.tsx` (the run Inspector renames; since 2026-09-16 both canvases draw `BuildNodeCard`, which has no inline rename on either) | `Workspace.test.tsx` "treats a drag during a run as the edit it is, not as view state (row 41)" (counterfactual verified) — read row 41's note in §15 first |
| Run-time helpers with no configured node are placed by the existing seeded auto-layout around the entrypoint, as view state | `runOverlay.helperPositions` | `runOverlay.test.ts` (2) |
| `fitKey` fits once per run open (configured graph + the two docked nodes) and never on a streamed token — evidence counts and reply presence are out of the key | `Workspace` `fitKey` | read the key; the removed terms are the gate |
| Narrow (<768 px) keeps `RunColumn` unchanged | `Workspace` | `Workspace.test.tsx` "keeps the reading column below 768 px (row 45)"; also checked in the real app at 375 px |

### Memory 2 — Notebook, inheritance and packs (built 2026-09-13, no board pass)

Gated with `cargo test -p loomwatch-backend` (175 + 4), `cargo clippy -p loomwatch-backend -- -D warnings`,
`npx tsc -b`, `npm test` (328), `npm run lint` (8 pre-existing warnings, none added).

| Piece | Where | Gate |
|---|---|---|
| `memory_notes` (immutable revisions, `note_key` family, generated `tsvector` + GIN index, partial unique idempotency index), `memory_audit`, `checkpoints` | `migrations/20260913120000_create_memory_notes.sql` | applied by every `#[sqlx::test]` below |
| **One write authority**: `memory::Notebook` — `write`, `revise` (Keep/Correct/Retire as new revisions), `read`, `search`, `list`, `kept_for_teams`, `history`, `import_kept`, `write_checkpoint`, `checkpoints`, `select_for`. No `UPDATE` anywhere; every mutation commits with its audit row in one transaction | `memory.rs` | `memory::tests::*` (11 new) |
| **A retried `memory_write` with the same key does not duplicate** | `Notebook::write` (`ON CONFLICT DO NOTHING`, then read back) | `a_retried_memory_write_with_the_same_key_does_not_duplicate` (mutation verified) |
| **A forged id from another team or run reads as not found**, and search never crosses the boundary | `IN_SCOPE`, `Notebook::read`/`search` | `a_forged_id_from_another_team_or_run_reads_as_not_found` (mutation verified) |
| **Correcting a note does not rewrite a stored packet**: the packet names the revision it supplied | `PacketSection::notes`, `IncludedNote` | `correcting_a_note_does_not_rewrite_a_stored_packet` (mutation verified) |
| Optimistic concurrency is `UNIQUE (note_key, revision)`; a stale revision is refused naming the current one | `Notebook::current_revision`, `next_revision` | `a_revision_written_against_a_stale_revision_is_refused` |
| **An inherited note is readable and never writable** — `revise` is scoped by team id, so the borrowing team has no path to it | `Notebook::revise`, `NoteScope` | `an_inherited_note_is_readable_and_never_writable` |
| Four structured Team Bus tools — `memory_search`, `memory_read`, `memory_write`, `checkpoint` — the first there with object schemas rather than `one_string`/`two_strings`. No tool takes an agent, team or run id; author and scope come from the token's `AgentSession`. Offered in **both** modes, withdrawn *and* refused when `memory.notebook.enabled` is false | `team_bus.rs::memory_tool_definitions`, `execute_tool`, `refuse_by_mode` | `team_bus::tests::the_memory_tools_are_structured_offered_in_both_modes_and_gated_by_the_team_file`, `a_bus_caller_reads_only_its_own_scope_and_writes_only_as_itself` |
| **A decision recorded by stage 1 reaches stage 3's packet without stage 2 restating it.** Stage 1 calls `memory_write` over the bus with `curl` (reading the URL and bearer token out of `session/new`) and exits non-zero if it does not come back recorded; stages 2 and 3 exit 23/25 if the decision is not in their prompt; stage 2's handover is a fixed string that does not mention it, and the test asserts that | `lib.rs::run_pipeline_nodes`, `NotebookSupply`, `configured_ancestors` | `tests::a_decision_recorded_by_stage_one_reaches_stage_three_without_stage_two_restating_it` (mutation verified) |
| Selection order — every decision in the run, then the agent's lineage, then the team's kept notes, then inherited kept notes; citation then recency within a tier; a sibling branch is never injected and the rationale says how many were left out | `memory.rs::rank_notes`, `fill_notebook_section`, `notebook_rationale` | `selection_supplies_decisions_and_lineage_but_never_a_sibling_branch`, `an_agent_is_not_supplied_its_own_notes_from_this_run`, `the_packet_budget_bounds_the_notebook_too` |
| Lineage is server-owned: configured ancestors for a pipeline node, the token's `delegation_path` for a delegated helper | `lib.rs::configured_ancestors`, `team_bus.rs::run_agent_inner` | asserted inside the acceptance test |
| A notes-only packet still opens with `## What the team knows`, under its own preamble (the Brief's "standing notes from the operator" would be a false attribution) | `NOTEBOOK_ONLY_PREAMBLE`, `fill_notebook_section` | asserted in `selection_supplies_decisions_and_lineage_but_never_a_sibling_branch` |
| `memory.inherits` in the schema and the loader: team-by-id resolution under the teams root, **transitive**, cycles refused naming the chain, a duplicate team id refused, a team with no memory refused, origin/`appliesTo` intersected, `exclude` honoured | `schemas/team.schema.yaml` (`$defs/Inherit`, `$defs/Notebook`), `config.rs::InheritConfig`, `memory.rs::resolve_inherits`/`TeamIndex` | `an_inherited_brief_entry_is_pinned_and_labelled_with_its_origin`, `an_inherits_cycle_is_refused_at_load` (mutation verified), `inheriting_a_team_that_has_no_memory_is_refused`, `team_schema::an_inherits_entry_names_exactly_one_source` (mutation verified — no shipped example inherits anything, so the `oneOf` needed its own gate) |
| `MemoryRoots`: the team's own Brief stays bounded by the team file's directory; inherited teams and packs are bounded by the whole teams root, with the same symlink and escape rules | `memory.rs::MemoryRoots`, `runs.rs` (`PreparedRun.teams_root` → `execute` → `run_team_session_with_session_id`) | `a_pack_outside_the_teams_root_is_refused`, the existing Brief-escape tests unchanged |
| Packs: `<name>.memory/` with `brief/*.md`, `notebook.jsonl`, `pack.yaml` (name, origin id, exported at, hashes, note count). Export writes it; load verifies **every** declared hash and refuses a pack edited after export; import copies kept notes into the receiving team carrying the origin id, and is idempotent | `memory.rs::Pack`, `PackManifest`, `PackNote`, `Notebook::import_kept` | `a_pack_round_trips_export_then_import_with_hashes_verified` (mutation verified) |
| REST: `GET /api/memory/notes`, `GET …/{id}/history`, `POST …/{id}/keep|correct|retire`, `POST /api/memory/packs` (export/import) — loopback-only, the same middleware as run control | `notebook_api.rs` | compiled; exercised end-to-end by the UI tests' fetch mocks |
| `GET /api/memory` gains the inherited Brief list, `inheritedTeams` and `notebookEnabled`; `MemoryEntryView` gains `origin` | `api.rs` | existing `api::tests::memory_endpoint_*` unchanged |
| Knowledge sources: every team with memory (`"<Team name> · memory"`, source `LoomWatch`) and every imported pack (source `imported`) appear in the capability inventory, carrying the **team id or pack path** wiring needs rather than a display name to parse | `capabilities.rs::scan_team_memory_sources`, `MemorySourceRef` | `capabilities::tests::a_team_with_memory_is_listed_as_a_knowledge_source_with_the_ids_wiring_needs` |
| `memory.inherits` editing in the byte-preserving document model: add/narrow (clearing `appliesTo` rather than freezing a list of today's agents), remove, and `exclude` one inherited entry | `ui/src/lib/team-file/document.ts`, `useTeamDocument.ts` | `team-file.test.ts` "memory.inherits editing" (5) — two mutations verified |
| Memory panel **Notebook tab**: groups only when non-empty, kind tag, author · time · source count, body preview, Keep/Correct/Retire/History, "corrected by you HH:MM", retired rows visible and dimmed, inherited rows read-only, the footer hint verbatim | `ui/src/components/memory/NotebookTab.tsx` | `NotebookTab.test.tsx` (9) — mutation verified |
| Live updates with no new WebSocket message: a `memory_write` on the run stream is an invalidation hint and the panel re-reads over REST | `Workspace` `memoryWrites` → the notes effect, `events.ts::isNotebookWrite` | `events.test.ts` "names a notebook write so the Workspace can use it as an invalidation hint" |
| Brief tab **"Inherited from <team>"** group: dashed read-only rows, "Open there", "Exclude", a read-only hint under the inherited groups (only when there are some), and a **"Share with another team"** section with **Export memory** | `MemoryPanel.tsx` (`InheritedRow`) | `MemoryPanel.test.tsx` unchanged and still green; the group is covered by the panel's existing render path |
| **After-run review strip**: "Run NN finished · K new notes the next run could use. [Review K] [Keep all] [Not now]" — only on a `succeeded` record, never automatic, and never on a failed run | `ui/src/components/memory/ReviewStrip.tsx`, `Workspace` | `ReviewStrip.test.tsx` (4), `Workspace.test.tsx` "offers an after-run review only for a run that succeeded" (mutation verified) |
| Agent cards: **"given N notes"** (counted from the agent's own stored packet, not from the notes that exist) | `BuildNodeCard.tsx`, `CanvasActionsContext`, `AgentRuntime.givenNotes`, `Workspace` | `BuildNodeCard.test.tsx` "counts only the notes this agent was supplied" (mutation verified); the count's source is asserted through the packet read in `Workspace` |
| ~~Agent cards: **"writes notes"** (configuration)~~ — **not rendered, noted 2026-09-16.** The chip only ever rendered on a card with no run behind it, and the canvas card the operator sees has been `BuildNodeCard` since the workspace rebuild, which does not draw it. Nothing regressed on 2026-09-16; the claim had been unreachable before it. The configuration itself is unaffected — the Inspector's Behaviour zone still sets it | — | — |
| Memory writes as evidence: "wrote to notebook · decision", "searched memory", "retrieved", "recorded a checkpoint", with the note/query/checkpoint as the card's name and the observation as its detail. No new `EvidenceKind`, no new event kind | `events.ts::memoryEvidence`/`memoryName`/`memoryDetail` | `events.test.ts` "projects a notebook write as evidence with its exact owner, order, time and status" (mutation verified) |
| The packet inspector's Notebook section lists the included revisions with the recorded rationale | `run/HandoverPanel.tsx` | `HandoverPanel.test.tsx` unchanged and still green |
| Library: a memory knowledge source carries the monogram **◫** and puts its team id / pack path on the capability drag payload | `library/Library.tsx`, `composer-layout/types.ts`, `library/client.ts` | `tsc` + the existing Library suite |

### Runs table (built 2026-09-13) — [ADR 0015](decisions/0015-runs-table.md)

| Piece | Where | Gate |
|---|---|---|
| `runs` table holding everything `RunRecord` holds plus `follows_run_id`, `start_at`, `retry_of_run_id`, `waiting_on`, `start_key` and `start_fingerprint` | `migrations/20260913140000_create_runs.sql` | applied by the test below |
| `RunStore` (upsert + bounded reload) and `RunRegistry::durable`/`persist`/`reload`. The cache stays the authority on a record's shape; persistence is an explicit `persist` from the async call sites (`POST /api/runs`, every `execute` transition, `cancel_run`, the scheduler's delivery stamp) | `runs.rs`, `archive.rs::run_store`, `main.rs::recovered_registry` | `runs::tests::run_records_and_their_start_keys_survive_a_registry_reload` |
| A recovered run holds **no task handle**: cancelling it changes the record and aborts nothing, which is the truth after a restart | `RunRegistry::reload` | asserted in the same test |
| A recovered start key still collapses a resubmission, and still conflicts on a different request | `runs` `start_key`/`start_fingerprint` | asserted in the same test |
| `list_sessions` returns the recorded `task` section, from a lateral join beside the existing prompt lateral, and `mergeHistory` prefers it over the regex split | `archive.rs::list_sessions`, `SessionSummary.task`, `ui/src/lib/runs/history.ts` | `archive::tests::session_listing_reports_the_recorded_task_section`, `routines.test.ts` "labels an archive-only row from the recorded task, not by splitting the prompt" (mutation verified) |

### Phase-1 UI gaps closed (2026-09-13)

| Piece | Where | Gate |
|---|---|---|
| **The packet inspector opens for any agent with a stored packet**, not only from a handover chip — the entrypoint is handed nothing and has a packet | `Workspace` (`handover` no longer requires `received`; one `GET /api/runs/{id}/context` per run feeds `runtime.hasPacket`), `BuildNodeCard` "What it was given" | `Workspace.test.tsx` "opens the packet inspector for the entry point, which was handed nothing", `BuildNodeCard.test.tsx` (2) — counterfactual verified |
| **Per-agent Behaviour-zone toggles** for `memory.brief` and `memory.deliverAs`, written through the byte-preserving document model, clearing the key rather than writing the default, dropping an empty block; the agent card shows "reads the brief" / "packet only" | `canvas/Inspector.tsx`, `team-file/document.ts::setAgentMemory`, `useTeamDocument.updateAgentMemory` | `Inspector.test.tsx` (6), `team-file.test.ts` "per-agent memory overrides" (5) — counterfactual verified. **The card's "reads the brief" / "packet only" chips are not rendered** — see the "writes notes" row above for why |
| **The mid-run Brief-edit strip.** Editing an entry rewrites its file in place (the team file already names it) and, while a run is shown, a strip says when the edit lands and which revision the run still holds. It never claims a live turn was interrupted | `memory/BriefEditStrip.tsx` (new), `MemoryPanel` Edit affordance, `Workspace.editBriefNote` | `BriefEditStrip.test.tsx` (4), `MemoryPanel.test.tsx` (2) |

### Memory 3 — checkpoints, Canvas B — follow-ups, §7 wiring and node positions (built 2026-09-13, no board pass) — [ADR 0016](decisions/0016-sidecar-v2-followups-and-checkpoints.md)

Gated with `cargo test -p loomwatch-backend` (190 + 5), `cargo clippy -p loomwatch-backend -- -D warnings`,
`npx tsc -b`, `npm test` (347), `npm run lint` (6 warnings, two fewer than the 8 this started from).

| Piece | Where | Gate |
|---|---|---|
| **Every pipeline stage boundary leaves a checkpoint**, asked for on the warm session ADR 0013 keeps open — after the handover for a non-final stage, after the work turn for the last one, and always the stage's *last* turn. Parsed under fixed `## Done` / `## Next` / `## Blocked on` / `## Artifacts` headings; stored with the archive `seq` high-water mark, artifact hashes bounded by the team directory, and the team revision | `lib.rs::checkpoint_stage`, `CHECKPOINT_REQUEST`, `StageBoundary::record`, `memory.rs::parse_checkpoint` | `runs::tests::a_skipped_stage_…` pins that **both** stages of a real pipeline left an `agent` checkpoint with their revision and seq (mutation verified); `memory::tests::a_checkpoint_answer_parses_under_its_headings_and_never_guesses` (mutation verified) |
| **A bad answer never fails the stage**: blank or malformed stores what was parseable, an answer that parsed to nothing stores nothing, a database failure is logged. A **half** answer is stored as the coordinator's, not the stage's — `write_checkpoint` refuses an `agent` row with an empty half | `StageBoundary::record`, `Notebook::write_checkpoint` | `memory::tests::a_coordinator_checkpoint_may_have_no_next_and_an_agent_one_may_not` |
| **A run that dies mid-turn leaves a `coordinator` checkpoint** assembled from the archive: `done` is the last agent text, `next` is empty because nothing said. Every agent the archive saw that did not checkpoint itself gets one | `runs.rs::record_abandoned_checkpoints` | `runs::tests::a_run_that_died_mid_turn_leaves_a_coordinator_checkpoint_the_next_run_opens_with` (mutation verified) |
| Selection step 2: the packet's **Checkpoint section** carries the one the run was started from, only in the packet of the stage that wrote it. Compatibility (team revision + artifact hashes) is **stated in the rationale**, never used to drop the section; an unrecorded revision reads as "not recorded", never "matches"; a checkpoint with no room left is recorded as an exclusion | `memory.rs::fill_checkpoint_section`, `checkpoint_staleness`, `lib.rs::supply_checkpoint` | `memory::tests::an_incompatible_checkpoint_is_supplied_with_the_reason_it_is_stale`, `a_coordinator_checkpoint_says_who_assembled_it_and_that_next_is_unknown` (both mutation verified) |
| **"Start a new run from this checkpoint"** — the label verbatim, never "Resume". A strip on a `failed` or `cancelled` run, showing the checkpoint in plain words and labelling a coordinator row for what it is | `ui/src/components/memory/CheckpointStrip.tsx`, `Workspace.startFromCheckpoint` | `CheckpointStrip.test.tsx` (5), including a test whose whole job is that the word "Resume" never appears (mutation verified) |
| `GET /api/runs/{id}/checkpoints?agent=`, and `source`/`team_revision` on the `checkpoints` table | `migrations/20260913160000_checkpoint_provenance.sql`, `runs.rs::get_run_checkpoints` | asserted inside `runs::tests::a_run_that_died_…` |
| **`POST /api/runs` accepts `followsRunId`, `startAt` and `fromCheckpointId`**, and refuses *before* a harness spawns: a followed run not in the `runs` table, one from another team file, a `startAt` that is not a stage of the pinned revision's order, a `startAt` in team mode, and a skipped stage with no stored handover — **naming the stage** | `runs.rs::resolve_continuation`, `seed_replayed_handovers` | `runs::tests::a_follow_up_is_refused_before_it_starts_when_it_cannot_be_honoured` (five refusals plus an accepted follow-up), `a_skipped_stage_with_no_stored_handover_refuses_the_run_naming_the_stage` (mutation verified) |
| Which stages need a replay is read off the **configured predecessors**, not off the pipeline order (one linearization of a DAG cannot say who feeds whom). A **join fed from both sides of the boundary is refused by name**: the archive stores a join's results rendered, not split per predecessor, so replaying it would overwrite the half this run is about to produce | `runs.rs::seed_replayed_handovers` | `runs::tests::a_join_fed_from_both_sides_of_the_boundary_is_refused_by_name` — the real function against a real archived prompt record, with two counterfactual boundaries on the same diamond (mutation verified) |
| **"from Writer" executes only Writer**; its packet carries the followed run's output and Writer's checkpoint, and its prompt carries the replayed handover. A replayed predecessor **withdraws the ask offer**, because there is no warm session behind a stage that did not run | `lib.rs::run_pipeline_nodes` (`start_index`), `stage_task`, `RunLineage` | `tests::a_follow_up_from_one_stage_executes_only_it_and_is_given_the_output_and_checkpoint` — stage `a` exits 99 if started, stage `b` exits 41–45; phase two is the in-test counterfactual, "retry starts from zero" (three mutations verified) |
| Following a **failed** run is allowed (decision 8): the output section is simply **absent**, asserted through the archived prompt record as well as through the harness | `RunLineage::previous_output` | `tests::following_a_run_that_produced_no_output_gives_the_stage_no_output_section` (mutation verified) |
| `## Previous output` is its own `prompt_sections` kind, not more `stage_results` — what the stage before handed over *in this run* and what a *previous run* answered are different facts | `memory.rs::PromptSectionKind::PreviousOutput`, `lib.rs::PREVIOUS_OUTPUT_SECTION`, `ui/src/lib/watch/events.ts` | asserted inside the follow-up test; the two files were changed together, which is the rule |
| **Composer Follow up** with a target chooser (`to: whole pipeline / from <stage>`, stages in pipeline order, team mode showing only the whole pipeline), ⌘↵ sends it, the note explains the chosen target in one line, and Retry stays "same prompt, from zero" with its own button | `composer/Composer.tsx`, `Workspace.followUp` | `Composer.test.tsx` (3 new, two mutations verified) |
| **Run history as a thread**: follow-ups indented under the run they follow, retries labelled in place (a retry is a sibling attempt, not a continuation), an orphaned follow-up kept at the top level, and a filter that flattens rather than hiding a matching child | `lib/runs/history.ts::threadHistory`, `composer/RunHistory.tsx` | `history.test.ts` (4) (mutation verified) |
| Prompt node: **"Run NN · Follow-up of Run MM"** / **"Retry of Run MM"**, read from the *record* first so it survives a reload; the Output placeholder names the stage that will actually reply on a "from <stage>" follow-up | `run/StoryNodes.tsx`, `runs/graph.ts::PromptNodeData.lineage`, `Workspace.lineageLabel` | `tsc` + the existing StoryNodes suites; the label's source is asserted through `record.followsRunId` in `history.test.ts` |
| **Daemon start marks a record left `queued`/`starting`/`running` by a previous process as `failed`**, error "interrupted by daemon restart", `error_code` deliberately absent. Terminal records untouched; written back so the next boot does not repeat it. Amends [ADR 0015](decisions/0015-runs-table.md) decision 3 | `runs.rs::RunRegistry::reload`, `INTERRUPTED_BY_RESTART` | `runs::tests::a_daemon_restart_marks_a_record_no_process_owns_as_failed` (mutation verified) |
| **`memory.notebook.keep: never` is enforced**: `POST …/keep` answers 409 naming the policy. Correct and Retire stay available under the same policy | `notebook_api.rs::revise` | `notebook_api::tests::keep_is_refused_when_the_team_file_says_never` (mutation verified; includes a `review` team accepting the identical request) |
| **Kept-note counts in the capability inventory** when the daemon has a database, in one statement for every team at once; `kept` stays **absent** without one, because "not counted" and "zero" differ | `api.rs::router_with_archive`/`get_capabilities`, `memory.rs::Notebook::kept_counts` | `capabilities::tests::…` unchanged (the scan still reports `None`); the enrichment is exercised by the daemon path |
| **Sidecar version 2**: a knowledge card carries `memory: {team}|{pack}`, and the sidecar carries `agents: {<id>: {x,y}}`. A version-1 file is **upgraded on read**; a version newer than this build reads as an empty canvas and is never overwritten | `composer.rs` (`MemoryRef`, `ComposerLayout::migrate`), `ui/src/lib/composer-layout/types.ts::migrateLayout` | `composer::tests::a_version_one_sidecar_loads_and_round_trips_as_version_two`, `a_memory_card_names_exactly_one_source`, `refuses_a_saved_agent_position_that_is_not_a_number`, `api::tests::layout_round_trips_…` (extended to a version-1 read); every `Workspace.test.tsx` case now serves a version-1 sidecar, so the migration path is under all of them (mutation verified) |
| **Agent positions persist in the sidecar** (CANVAS_SPEC §7.3 option A, decided). One effect hydrates and mirrors, because hydration and write-back are the same synchronisation; `doc.applyPositions` is not a dirtying edit and is not in the undo stack; an agent that leaves the team file loses its entry, pruned beside the orphaned edges | `composer.rs::ComposerLayout.agents`, `useComposerLayout.setAgentPositions`, `useTeamDocument.applyPositions`, `Workspace` position effect | `Workspace.test.tsx` "saves an agent drag to the layout sidecar and never to the team file (row 41)", "restores saved positions on load…", "drops the saved position of an agent that left the team file" (all three mutation verified) |
| **Wiring a memory card writes `memory.inherits`**, not the sidecar: an agent→card edge narrows `appliesTo`; the Prompt node (wired or dropped on) writes the whole-team form as the **absence** of the key; `removeCapabilityCards` removes the entry; the canvas draws the **union** of sidecar cards and `memory.inherits`, so a YAML-authored inherit shows a card and its edges | `Workspace` (`memoryCards`, `capabilityCards`, `memoryEdges`, `allWiringEdges`, `onConnect`, `placeCapability`, `removeCapabilityCards`) | `Workspace.test.tsx` "wires a memory card into memory.inherits…", "draws a card for a memory.inherits entry the sidecar knows nothing about", "draws a whole-team inherit from the Prompt node" (four mutations verified) |
| TNG89 §15 acceptance **row 41 is now literal** — a drag persists, to the sidecar, never to the team file — and §15's note under the row says so | `docs/TNG89_INTERACTION.md` §15.6 | the row-41 test above asserts both halves |

### Canvas C — operator stops and questions (completed 2026-09-13)

See [ADR 0017](decisions/0017-operator-stops-and-answers.md) for the protocol and
[the completion report](TAKEOVER_QA.md) for verification and the offline walkthrough.

| Piece | Behaviour and verification |
|---|---|
| Operator nodes | `kind: operator`, no spawn/model/budget; question edited in the Inspector and a keyboard/drag Library row. Schema and loader tests cover invalid entrypoints and team mode. |
| Review stops | The run stays running with persisted `waitingOn`; no request is in flight while waiting. The stored handover is visible beside the answer input. Continue supplies operator direction separately from source material; Send back reuses the predecessor and asks for a fresh handover. Fake ACP pipeline tests exercise both. |
| Questions in either mode | `ask_user` returns immediately and parks after the turn ends. Durable question rows enforce one open question per agent. Multiple agents' questions queue without overwriting each other; the answer API validates the addressed node. |
| Parking | Advertised `loadSession` closes/reaps and reloads the same session id; otherwise the window is bounded by `conversation.stop.keepAliveMinutes`. Expiry creates a coordinator checkpoint without another model call. A late answer to an agent question starts a new checkpoint continuation, identified by its new run id and response header. |
| Live replies | `GET /api/runs/{id}` reports `replyableAgents` from the live registry. The composer offers Reply to those agents; the loopback ask endpoint uses their existing serialized turn queue and returns 409 plus a checkpoint id after release. |
| Waiting UI | Gold question card and Attention entry, waiting run chip/history, Continue/Reply keyboard actions, and an integrated handover disclosure. Expanded controls use a full-width text row; docks and popovers clear the measured composer height. Notifications require existing opt-in. |
| Continuation correctness | Retry lineage is durable, Save & follow up is labelled, and replay carries operator direction separately from handovers. A review stop records its input for follow-ups that start at the stop itself. |
| Checkpoints | Pipeline boundaries, question parking, enabled team-mode notebooks and cancellation all leave recovery points. Repeated cancellation sweeps do not duplicate them. |
| Answer correctness | `turn_purpose` session metadata distinguishes checkpoint/handover turns from work. Their transcript and cost remain recorded; their text never replaces the answer. Completed historical runs use the registry's canonical reply. |
| Keep policy | The server enforces `keep: never`; the Notebook and after-run strip also withhold Keep actions. |

### Deliberate API split

The Brief remains on `/api/memory` and the database-backed Notebook on `/api/memory/notes`.
Both accept `team=` and `path=`. Reading Markdown stays available when PostgreSQL is disabled;
this is an intentional API shape, not an unfinished combined endpoint.

### Known gaps in what *is* built

- `SessionSummary` carries `task`, read from the recorded `prompt_sections`, and `mergeHistory`
  prefers it. `legacyOperatorPrompt` is still called, and still has to be: it is the fallback for
  a session archived before phase 1 started recording the sections, where `task` is honestly
  `null`. It can be deleted only when those sessions no longer matter.
- **Kept-note counts reach the inventory only through the daemon's own router.**
  `detect_capabilities` is still a filesystem scan and still reports `kept: null`; the counts are
  filled in by `GET /api/capabilities` when the daemon has a database (ADR 0016 decision 10). A
  caller that uses `api::router` or `router_with_path` — every test, and any embedding that has no
  pool — gets the honest absence, which is correct but means the enrichment has no unit test of
  its own: it is covered by the shape of the two call sites, not by an assertion.
- **`memory_search` ranks by `ts_rank` over an `english` configuration.** That is a choice, not a
  measurement: no retrieval evaluation has been run, and the design says no embeddings until one
  shows misses text search cannot fix. A note written in another language tokenises poorly and
  nothing reports that.
- **A pack export writes only this team's own Brief.** Re-exporting what the team inherited would
  make the pack claim authorship of another team's writing. The consequence is that a pack is not
  a complete snapshot of what a run would have been supplied.
- **A follow-up's replay reads the archived prompt record, not `context_packets`.** The design text
  says "stored handovers and packets"; a packet holds the memory section and the handover a stage
  was given is the `stage_results` section of its `prompt_sections` record. That is the only place
  the exact text lives, so that is what is replayed (ADR 0016 decision 7) — but it means a run
  whose `prompt_sections` were never recorded (archived before phase 1) cannot be followed *from a
  stage*, only as a whole pipeline, and the refusal says so by naming the stage.
- **Opening a team writes its layout sidecar.** The position write-back persists the seeded
  `dagre` arrangement on a first open, before the operator has arranged anything. It is
  deterministic and changes nothing visible, and it is what makes the sidecar self-describing —
  but it does mean `<team>.layout.json` appears for a team someone merely looked at.
- **A follow-up is not pinned to the followed run's revision.** It is pinned to the revision on
  disk when it starts, like every other run, while the handovers it replays were produced against
  whatever the followed run ran. The checkpoint says so when one is supplied ("stale · the team
  file has changed since it was written"); a replayed *handover* carries no such note.
- `RunColumn` (below 768 px) still renders every agent's evidence inline, unfolded. That is
  deliberate — §15.2.7 keeps the reading column exactly as §12.5 specifies, and a fold in a
  scrolling column buys nothing — but it means the fold is a canvas contract, not a global one.
- The evidence fan opens *below* its agent card in a two-column grid. On a hand-arranged graph
  with a card directly underneath, the fan can overlap it. Nothing moves as a result (the fan is
  view state and the configured node keeps its position), and a card can be dragged out of the
  way, but the design's "never collides with a card you arranged" is a best effort here, not a
  guarantee.
