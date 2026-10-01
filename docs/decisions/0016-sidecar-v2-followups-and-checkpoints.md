# ADR 0016 — Sidecar v2 (memory cards and agent positions), follow-ups, and checkpoints as a mechanism

Status: accepted · 2026-09-13 · amends [ADR 0011](0011-planned-capability-sidecar.md) and
[ADR 0015](0015-runs-table.md) · decides [`CANVAS_SPEC.md` §7.3](../CANVAS_SPEC.md) ·
implements the Canvas B and memory-phase-3 rows of
[`TEAM_MEMORY.md` §10](../TEAM_MEMORY.md#10-delivery-sequence) ·
adds [`migrations/20260913160000_checkpoint_provenance.sql`](../../migrations/20260913160000_checkpoint_provenance.sql)

## Context

Four things were carried but not connected, and each of them was a sentence the tree could not
keep:

1. **The `checkpoints` table had no writer.** The `checkpoint` bus tool wrote rows, but nothing
   *asked* for one, so `PacketSectionKind::Checkpoint` was a shape with no producer and "Start a
   new run from this checkpoint" did not exist. A run killed by the ten-minute ACP request timeout
   left evidence and no continuable state.
2. **`POST /api/runs` ignored `followsRunId`/`startAt`.** ADR 0015 shipped the columns deliberately
   so Canvas B would be a handler change. This is that handler change.
3. **A memory knowledge card could not say which memory it was.** A `<team>.layout.json` card had
   `kind`, `name` and a display-only `source`; wiring it went through `composerLayout.connect`,
   which writes the *sidecar*. The operator drew a line and the daemon supplied nothing. The
   missing field is a team id or a pack path.
4. **Node positions lived nowhere.** `CANVAS_SPEC.md` §7.3 flagged the question and did not decide
   it, `useTeamDocument` said so in as many words, and TNG89 §15 acceptance row 41 ("a drag during
   a run dirties the document") was therefore unsatisfiable as written — a drag could not dirty
   anything, because there was nothing for it to dirty.

## Decisions

### 1. The sidecar goes to version 2, and version 1 is upgraded rather than refused

`<team>.layout.json` gains two fields, both additive:

- `nodes[].memory: { team } | { pack }` — which memory a knowledge card stands for. Exactly one of
  the two, checked server-side, because the team schema's own `inherits` says the same with a
  `oneOf`.
- `agents: { <agentId>: {x, y} }` — where the operator put each **agent** card.

A version-1 file has neither, which is already what "no positions saved" and "not a memory card"
mean, so `ComposerLayout::migrate` stamps the version forward and changes nothing else. A version
*newer* than this build still reads as an empty canvas **and is never overwritten** — the client
leaves `loadedFor` unset, which is what suspends the autosave (ADR 0011 decision 5's rule that a
sidecar which could not be read is not replaced by the empty one shown in its place).

### 2. Positions in the sidecar, contract in the team file — §7.3 option A

The three options §7.3 lists were weighed once more and the recommendation stands. `x`/`y` cannot
go into the team file: the root schema and `$defs.Agent` are `additionalProperties: false`, and
`ARCHITECTURE` §5 wants team design diffable — position churn in the file reviewers read is a real
cost. `localStorage` loses the arrangement on the next machine, which defeats a daemon-served UI
(ADR 0003). The sidecar already exists, already autosaves, and already carries exactly this class
of thing: **editable intent the daemon stores and never executes.**

Consequences taken deliberately:

- **The document stays the authority on where a card is.** Every position mutation goes through
  `doc.nodes` — a drag, `settleNodeCollision`, the explicit auto-layout, undo — so the Workspace
  mirrors the document *into* the sidecar rather than the other way round. One effect does both
  halves, because hydration and write-back are the same synchronisation and splitting them made
  the write-back miss the render hydration happened on.
- **`applyPositions` is not a dirtying edit and is not in the undo stack.** It restores positions
  the document already had, arriving from the sidecar a moment after the YAML. That is what makes
  a drag never dirty the team file.
- **Opening a team writes its seeded layout.** On a first open with no saved positions the
  write-back persists the deterministic `dagre` arrangement the canvas is already showing. It
  changes nothing visually (the seed is the team id, so the same file opens the same shape
  anywhere) and it makes the sidecar self-describing from then on. The alternative — writing only
  after a drag — needs every position mutation to remember to mirror, which is exactly the class
  of bug the single effect avoids.
- **An agent that leaves the team file loses its saved position**, pruned in the same
  `useComposerLayout` effect that prunes orphaned edges, for the same reason (ADR 0011 decision 6):
  a stored position for a card that is gone would come back if the id were ever reused.

### 3. Wiring a memory card writes the team file, not the sidecar

Drawing an edge from an agent to a memory card writes `memory.inherits[].appliesTo` through the
byte-preserving document model. That is executable configuration in ADR 0012's sense — it changes
what the daemon sends — so it lives in the team file and the operator saves it explicitly and sees
it in the YAML preview. The *position* stays in the sidecar. The split is ADR 0011's, unchanged.

Three details are decisions, not conveniences:

- **`appliesTo: undefined` is written as the absence of the key**, never as a list of today's
  agents: a team that later gains an agent should supply the inherited memory to that one too, and
  a frozen list would silently stop doing so.
- **The Prompt node is the whole-team gesture.** Dropping a memory card on it, or drawing an edge
  from it, writes the no-`appliesTo` form. The Prompt node is the operator, and the operator's
  scope is every agent; the design's "wiring with no agent" has no other node to mean.
- **The canvas draws the union of the sidecar's cards and `memory.inherits`.** An entry written by
  hand in the YAML gets a card and its edges, so the canvas and the team file are one picture.
  A synthetic card is placed by the same deterministic slot finder click-placed cards use, and
  dragging one creates the real sidecar card at that position.

Removing a memory card removes the `memory.inherits` entry — the Markdown and the pack folder on
disk are untouched, because the card is a reference, not the writing.

### 4. Every pipeline stage boundary leaves a checkpoint, asked for in the warm session

At its boundary — after the handover for a non-final stage, after the work turn for the last one —
each stage is asked, on the session ADR 0013 already keeps open, for `## Done` / `## Next` /
`## Blocked on` / `## Artifacts`. The answer is parsed under exactly those headings and stored with
the archive `seq` high-water mark, the artifact hashes, and the team revision.

**This is one more turn per stage, on top of ADR 0013's handover turn, and that cost is real.** It
is a turn on a context that is already loaded, and what it buys is that "Start a new run from this
checkpoint" works for *every* stage rather than only for stages whose model chose to call the
`checkpoint` tool. Asking it **last** is what makes it useful: a stage's final act is to say where
it stopped, which is the only moment it can.

Three refusals inside this:

- **A bad answer never fails the stage.** A blank or malformed reply stores what was parseable; an
  answer that parsed to nothing stores nothing and says so in the log; a database failure is
  logged. A stage that did its work must not be failed because it wrote a bad checkpoint.
- **A half answer is stored as the coordinator's, not the stage's.** `write_checkpoint` refuses an
  `agent` row with an empty `done` or `next`, because that is a boundary nobody can continue from.
  What is stored is then labelled for what it is: no longer what a stage said in full.
- **The parser reads the answer, never the prompt.** It looks for a line that is one of the four
  headings, ignores anything before the first, and lets an unknown heading *close* the current
  section rather than join it — a model that adds `## Notes` must not have them filed under
  Artifacts.

The contract change broke every pipeline fixture, which had to learn the extra turn. That is the
same consequence ADR 0013 recorded for its own second turn, and the same resolution: the fixtures
assert the new turn rather than being relaxed around it.

### 5. A run that ends abnormally gets a `coordinator` checkpoint from the archive

When `execute` sees a failed run, every agent the archive saw that did *not* checkpoint itself gets
one row assembled from what the archive holds: `done` is the last agent text, `next` is **empty**.
Empty is the point — nothing said what came next, and a sentence there would be the daemon's guess
wearing a stage's voice. The packet renders it as "Next: not recorded — nothing said what this
stage would pick up", and the strip says LoomWatch assembled it.

A **cancelled** run gets none: `cancel` aborts the task, so `execute` never reaches this path. That
is a known gap, not a claim.

### 6. Compatibility is stated, never used to drop the checkpoint

A continuation's packet carries the checkpoint even when the team file has moved or an artifact no
longer hashes to what it claimed. The reason is stated in the section's rationale instead
("stale · the team file has changed since it was written"). Silently dropping it would let a
continuation start from nothing while calling itself a continuation. A checkpoint with **no**
recorded revision — every row the `checkpoint` bus tool writes, because the bus is not told which
revision the run was pinned to — reads as "not recorded", never as "matches".

### 7. `POST /api/runs` accepts `followsRunId`, `startAt` and `fromCheckpointId`, and refuses early

Every refusal happens before the run is registered and before a harness spawns, because a refusal
that surfaced mid-run would already have cost money:

| Refused | Why |
|---|---|
| A followed run that is not in the `runs` table | An archive-only session has evidence but no record, so nothing can say which team file it ran |
| A followed run from a different team file | Same reason, one step less obvious |
| `startAt` naming something that is not a stage of the current pipeline order | Checked against the order of the revision *this* run is pinned to, not against what is on disk |
| `startAt` in team mode | `edges: []` means there is no configured order; "from the third agent" is not something the file expresses |
| A skipped stage with no stored handover, **naming the stage** | Continuing would hand that stage nothing where it had been handed a page, and would look like a cheap follow-up that worked |
| A DAG join fed from **both sides** of the boundary, naming the join and both sets of predecessors | The archive stores a join's `## Results from preceding stages` **rendered**, not split per predecessor, so replaying it would overwrite the half this run is about to produce with the old one — a follow-up that quietly ignored the work it just did. Splitting the text back apart is not possible, so the refusal says what to do instead: the whole pipeline, or start at the join |

`fromCheckpointId` alone is enough: the run followed and the stage started at are properties of the
checkpoint, not choices the client makes. In team mode it derives **no** `startAt` — there is
nothing to skip — so "Start a new run from this checkpoint" does not refuse itself on every
team-mode team.

**Handovers are replayed from the archived prompt record, not from `context_packets`.** The design
text says "stored handovers and packets"; `context_packets` holds the memory packet, and the
handover a stage was given is the `stage_results` section of its archived `prompt_sections` record.
That is the only place the exact text lives, so that is what is replayed.

Which stages need a replay is read off the **configured predecessors**, not off the pipeline order:
the order is one linearization of a DAG and cannot say who feeds whom, and the split-join refusal
above is only expressible against the real edges.

A replayed predecessor **withdraws the ask offer**: there is no warm session behind a stage that did
not run, and telling an agent something is reachable when it is not is the one kind of lie this
design refuses. The honest cost is that a replayed handover has to stand on its own.

`## Previous output` is a new `prompt_sections` kind rather than more `stage_results`, because they
are different facts — what the stage before this one handed over *in this run*, versus what a
*previous run* answered — and collapsing them would leave the packet inspector unable to say which.
Following a **failed** run is allowed (decision 8): the section is simply absent.

### 8. A record left non-terminal by a previous process is failed at boot

This **amends ADR 0015 decision 3**, which left such a record `running` on the grounds that the
daemon does not know whether the harness finished, and named the columns a reconciliation would
need. The amendment: a record left `queued`, `starting` or `running` by a process that is gone is
not a run whose state is unknown — it is a run whose **supervisor** is gone. This process holds no
task handle for it, nothing will ever advance it, and `RUN_PROVENANCE_CONTRACT.md` §3.2 already
routes a supervisor failure to `failed`.

What is minted matters, so nothing is: `error` is the operator-facing prose "interrupted by daemon
restart", which is a true statement about the *daemon*; `error_code` stays absent, because the
contract defines no code for this and a plausible token would be worse than none. Terminal records
are untouched, and the reconciliation is written back so the next boot does not repeat it.

### 9. `memory.notebook.keep: never` is enforced

It was loaded, served on `GET /api/memory/notes`, and read by nothing: Keep was still offered and
the daemon would still have accepted it. A policy the server does not enforce is a comment.
`POST /api/memory/notes/{id}/keep` now answers 409 naming the policy. Correct and Retire stay
available — they change this run's record, not what outlives it.

### 10. Kept-note counts reach the capability inventory when there is a database

`detect_capabilities` is a filesystem scan and cannot count rows, so every live team's memory source
came back with `kept: null`. The REST router now takes the archive for exactly one handler,
`GET /api/capabilities`, and fills the counts in one statement for every team at once. Without a
database the field stays **absent**, because "not counted" and "zero kept notes" are different
answers. Nothing else in that router depends on Postgres: reading a team's Brief is reading Markdown
off disk and must work with the archive down (the reason `/api/memory/notes` lives in its own
router at all).

## Consequences

- Every pipeline stage costs one more turn. Measured against a run that spawns processes and
  archives hundreds of events it is small; measured against a paid harness it is not free, and it
  is the price of a continuable run.
- `<team>.layout.json` is now written when a team is merely opened, not only when a card is placed.
  It is still a file the operator can delete and re-derive by re-arranging.
- TNG89 §15 acceptance row 41 becomes literally satisfiable: a drag writes the sidecar, never the
  team file. §15's note under the row is updated to say so.
- The retry `Map` in `Workspace.tsx` is still there. `retry_of_run_id` is now written by
  "Start a new run from this checkpoint" but not yet by Retry, so the client-side lineage is still
  the only record of a retry. Closing that is a one-line handler change with its own test.
- A cancelled run leaves no coordinator checkpoint. Naming it here is the honest position.

## Gate

Backend — `cargo test -p loomwatch-backend` (190 + 5), `cargo clippy -p loomwatch-backend -- -D warnings`:

- `tests::a_follow_up_from_one_stage_executes_only_it_and_is_given_the_output_and_checkpoint` —
  stage `a` exits 99 if started, stage `b` exits 41–45 if the replayed handover, the previous
  output, the checkpoint, its heading, or the *absence* of the ask offer is wrong. Phase two is the
  counterfactual in the same test: the same team with an empty lineage runs `a` and fails.
- `tests::following_a_run_that_produced_no_output_gives_the_stage_no_output_section` — exits 46 if
  a `Previous output` heading appears, and the archived prompt record is checked for its absence.
- `runs::tests::a_skipped_stage_with_no_stored_handover_refuses_the_run_naming_the_stage` — the
  refusal names the stage; the counterfactual runs the pipeline for real and "from b" is accepted,
  and the same test pins that **both** stages left an `agent` checkpoint with their revision.
- `runs::tests::a_run_that_died_mid_turn_leaves_a_coordinator_checkpoint_the_next_run_opens_with` —
  `done` is the archived partial text, `next` is empty, and the run started from it opens with it.
- `runs::tests::a_follow_up_is_refused_before_it_starts_when_it_cannot_be_honoured` — the
  refusals above, plus an accepted whole-pipeline follow-up.
- `runs::tests::a_join_fed_from_both_sides_of_the_boundary_is_refused_by_name` — the real
  `seed_replayed_handovers` against a real archived prompt record, with two counterfactual
  boundaries on the same diamond where the replay *is* unambiguous.
- `runs::tests::a_daemon_restart_marks_a_record_no_process_owns_as_failed` — all three non-terminal
  statuses, a terminal one untouched, and the write-back proven by a third reload.
- `memory::tests::a_checkpoint_answer_parses_under_its_headings_and_never_guesses`,
  `a_coordinator_checkpoint_may_have_no_next_and_an_agent_one_may_not`,
  `an_incompatible_checkpoint_is_supplied_with_the_reason_it_is_stale`,
  `a_coordinator_checkpoint_says_who_assembled_it_and_that_next_is_unknown`.
- `notebook_api::tests::keep_is_refused_when_the_team_file_says_never` — with Retire still allowed
  under the same policy, and a `review` team accepting the identical request.
- `composer::tests::a_version_one_sidecar_loads_and_round_trips_as_version_two`,
  `a_memory_card_names_exactly_one_source`,
  `refuses_a_saved_agent_position_that_is_not_a_number`,
  `prunes_edges_whose_agent_left_the_team_file` (extended to positions),
  `api::tests::layout_round_trips_beside_the_team_file_without_touching_it` (extended to a
  version-1 read).

UI — `npx tsc -b`, `npm test` (347), `npm run lint` (6 warnings, down from 8):

- `Workspace.test.tsx` — "saves an agent drag to the layout sidecar and never to the team file
  (row 41)", "restores saved positions on load…", "drops the saved position of an agent that left
  the team file", "wires a memory card into memory.inherits, and removing the card removes the
  entry", "draws a card for a memory.inherits entry the sidecar knows nothing about", "draws a
  whole-team inherit from the Prompt node".
- `Composer.test.tsx` — the chooser's order, ⌘↵ sending the follow-up rather than a new run, the
  target named in the note, team mode offering only the whole pipeline, and a build with no
  follow-up handler keeping Retry + New run.
- `CheckpointStrip.test.tsx` (5) — the label verbatim and **no "Resume" anywhere**, the coordinator
  labelling, the stage the run reached last, nothing rendered with no checkpoint, a failed start
  reported in place.
- `history.test.ts` (4) — follow-ups indented, retries labelled in place, an orphan kept at the top
  level, the record's lineage fields carried through.

Every one of these was reverted one at a time and confirmed to go red; the mutations are listed in
the handoff report.
