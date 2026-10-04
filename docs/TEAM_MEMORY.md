# Team memory

How a LoomWatch team remembers: a **Brief** of shared instructions and files, a **Notebook** of
notes that carry from one run to the next, and **checkpoints** at every stage boundary. This page
says what each one is, how it reaches an agent, and how to configure it.

---

## 1. What the team forgets

Four losses, each a line in the tree rather than a hypothesis.

| Loss | Where | What an agent actually receives |
|---|---|---|
| Delegated helpers start blind | `team_bus.rs::run_agent_inner` | Its `role`, its wired skills, and the one string its caller typed into `dispatch`/`ask`. No goal, no constraints, no findings so far. It also skipped `workspace::materialise`, so it got no delivered capabilities either. |
| Pipeline stages only see one hop back | `lib.rs::run_pipeline_nodes` | The original prompt plus the handover its direct predecessor wrote. Stage 3 never sees what stage 1 decided unless stage 2 restated it. |
| Nothing survives the run | `migrations/`, `runs.rs` | The only table was append-only `run_events`; the run registry is in memory. |
| Long sessions compact invisibly | `acp.rs::record_frame` | The harness compacts its own window; ACP reports nothing LoomWatch can act on. |

Two existing mechanisms point the way and are reused rather than duplicated. Pipelines stopped
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
map of what each stage handed forward is `handovers`, never `briefs`.

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

Which file each harness reads (verified against each harness):

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
metadata and questions travel over REST, so the live WebSocket messages do not change.

## 7. API

| Route | Purpose |
|---|---|
| `GET /api/memory?path=` | The team's Brief: entries, scopes, budget, `deliverAs`. A team with no block reports an honest nothing; an unreadable Brief is a 422 naming the entry. |
| `PUT /api/memory/file` | Write one Brief Markdown file beside the team YAML. `{path, file, body}`. Bounded to the team's own directory. The `memory.brief` line is a team-file edit and goes through the UI's document model instead. |
| `GET /api/runs/{id}/context?agent=` | The stored packets with sections and rationale, for the inspector. |
| `POST /api/runs` | Gains `followsRunId`, `startAt` and `fromCheckpointId`. Earlier stages replay their handovers from the archived `prompt_sections` record — `context_packets` holds the memory packet, not the handover. |
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

## 10. What keeps it fast

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
