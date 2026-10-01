# ADR 0014 — Team memory: the Brief on disk, packets in Postgres

Status: accepted · 2026-09-13 · supersedes nothing · amends
[`schemas/team.schema.yaml`](../../schemas/team.schema.yaml) (schema version stays `1`)

## Context

A LoomWatch team forgets four things, each of them a line in the tree rather than a hypothesis:

| Loss | Where |
|---|---|
| A delegated helper starts blind — its role, its wired skills, and the one string its caller typed into `dispatch`/`ask`. It also skipped `workspace::materialise`, so it got no delivered capabilities either. | `team_bus.rs::run_agent_inner` |
| A pipeline stage sees one hop back: the run's prompt plus its direct predecessor's handover. Stage 3 never sees what stage 1 decided unless stage 2 restated it. | `lib.rs::run_pipeline_nodes` |
| Nothing survives a run. The only table was append-only `run_events`. | `migrations/`, `runs.rs` |
| A long session compacts invisibly. The harness compacts its own window and ACP reports nothing LoomWatch can act on. | `acp.rs::record_frame` |

Fixing the first two needs somewhere for the operator's standing constraints to live, and a
record of what each agent was actually handed. This ADR decides where each of those lives and
why. The full design, including the phases this ADR does not implement, is
[TEAM_MEMORY.md](../TEAM_MEMORY.md).

## Decision

### 1. The Brief lives on disk, beside the team YAML

A `memory:` block in the team file names Markdown files relative to it:

```yaml
memory:
  brief:
    - path: brief/constraints.md          # whole team
    - path: brief/tone.md
      appliesTo: [writer]
  packet:
    maxChars: 8000
  deliverAs: native-file
```

The alternative was a Postgres table with optional file references. Rejected: the Brief is the
operator's own writing and it changes what the daemon sends to a harness, so it belongs in the
same reviewable, diffable, version-controlled artefact as the rest of the design. Postgres holds
only what agents write, and the exact bytes each agent was handed.

This is also why the block is in `team.schema.yaml` rather than the layout sidecar: ADR 0012's
rule is that anything changing what reaches a harness is executable configuration and lives in
the team file. The block is a sibling of `conversation`, and the schema's root stays
`additionalProperties: false`, so `$defs/Memory`, `$defs/BriefEntry`, `$defs/Packet` and
`$defs/AgentMemory` are added rather than the root being loosened.

**Omitting the block, or `enabled: false`, keeps every prompt byte-for-byte what it was.** That
is pinned by a test (`lib.rs`: `a_team_without_memory_gets_exactly_the_prompt_it_got_before`),
not by inspection.

### 2. Brief files are read only from under the team's own directory

Paths are relative to the team file, resolved with `fs::canonicalize` — which resolves symlinks —
and then required to be under the root. An absolute path, a `..` escape, or a symlink pointing
outside is refused and names the entry. Team files are not trusted input; the same rule already
governs `spawn.cmd` and skill delivery.

The bound is the *team file's own directory*, which is tighter than the teams root. A Brief
belongs to one team, and the tighter bound is the correct one for phase 1. Memory packs (phase 3)
will widen it to the teams root deliberately, in their own change.

### 3. `deliverAs: native-file` is the default, and it implies the managed workspace

Every supported harness reads a project memory file from its working directory — `CLAUDE.md`,
`AGENTS.md`, `GEMINI.md`. Writing the Brief there means the harness reloads it into its own system
prompt, which is the one place a context compaction LoomWatch cannot observe does not reach. So a
memory-enabled agent runs in `.loomwatch/<team>/<agent>/` exactly as wiring a skill already moves
it (ADR 0012).

An agent that must run inside a repository sets `memory.deliverAs: packet-only` on itself, keeps
its declared `cwd`, and the Memory panel states what that costs rather than hiding it.

Which file each harness reads was verified on this machine, not assumed: pi's
`--no-context-files` flag names `AGENTS.md` and `CLAUDE.md` explicitly, and the Hermes and
OpenClaw bundles reference `AGENTS.md` far more than any alternative. A harness LoomWatch does not
recognise gets **no** file — inventing a name would deliver nothing while looking like it worked —
and reaches the Brief through the packet alone.

### 4. The packet is recorded before it is sent

`context_packets` (new migration) holds, per run and agent and invocation: the rendered text, the
sections with their character counts and selection rationale, the Brief path and content hash each
section came from, and the budget. It is written **before** `session/prompt`, so a crash between
the two leaves a record of what was about to be supplied rather than a prompt nothing explains.
`GET /api/runs/{id}/context?agent=` serves it.

The alternative was for the UI to keep deriving this from the archived prompt. Rejected, and this
is the concrete reason: `ui/src/lib/watch/events.ts` split the prompt on the literal headings
`## Your assigned role` and `## Results from preceding stages`, so the new `## What the team
knows` section would have been silently attributed to whichever neighbouring part the regex
swallowed — quietly changing what the Prompt node and the handover panel claimed an agent was
shown. The daemon composes the prompt, so the daemon records what it is made of.

### 5. Two additive `session_meta` subtypes, and no new event kind

`run_events` and the WebSocket schema are untouched.
[WEBSOCKET_SCHEMA.md](../WEBSOCKET_SCHEMA.md) §3 already treats `session_meta` phases as an open
set, so `context_packet` and `prompt_sections` are documented additions rather than an unfreezing.
Memory updates ride the existing stream as invalidation hints and are read back over REST; there
is no second live channel.

### 6. `briefs` becomes `handovers`

The backend called a stage's handover a `brief` (`run_pipeline_nodes`) while the UI already said
"handover". With "Brief" now meaning the operator's standing notes, the internal map is
`handovers` and `brief_request` is `handover_request`, so the two cannot collide in review.

### 7. The daemon writes Markdown; the UI writes YAML

`PUT /api/memory/file` writes one Brief Markdown file beside the team YAML. Registering it in
`memory.brief` is a team-file edit and goes through `useTeamDocument`, so the operator reviews and
saves it like any other change. The alternative — the daemon editing the team YAML — would give
the tree a second, competing YAML writer against a byte-preserving contract the UI already owns.

## Consequences

- A constraint written once reaches the entrypoint, a downstream stage, and a delegated helper.
  All three are pinned by tests whose fake harnesses exit non-zero when the constraint is absent,
  and each was verified to fail when the wiring is reverted.
- Pinned Brief content that does not fit `packet.maxChars` refuses the run **before** a harness
  spawns, naming the entries and the overage — the same contract an undeliverable skill has.
- A delegated helper now goes through `workspace::materialise`, so it also receives the
  capabilities the operator wired to it. That was a latent bug this change closes as a side
  effect, and it means a helper with wired capabilities now runs in the managed workspace.
- `conversation.brief` keeps its name. It bounds the *handover*, and renaming a shipped
  configuration key to match internal vocabulary is not worth a migration.
- `agent_prompt` is replaced by `compose_prompt`, which returns the text and the section record
  from one function so they cannot drift.

## What this ADR does not decide

The Notebook (`memory_notes`, the four bus tools, lineage selection), checkpoints, inheritance and
packs, and the `runs` table each have their own step in
[TEAM_MEMORY.md](../TEAM_MEMORY.md#delivery-sequence). This ADR covers the Brief, the packet, and
the schema change they need.
