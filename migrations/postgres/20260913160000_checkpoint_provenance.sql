-- Memory phase 3: a checkpoint now says who wrote it and what team revision it belongs to.
--
-- `source` distinguishes the two writers the design names (docs/TEAM_MEMORY.md §6, "Written at
-- stage end, on park, and by the `checkpoint` tool"). An `agent` row is what a stage answered in
-- its own warm session; a `coordinator` row is what LoomWatch recorded *about* a stage that ended
-- abnormally, from whatever the archive held. They are not interchangeable: a continuation packet
-- labels them differently, because "the stage said what it would pick up next" and "the daemon
-- found no such statement" are different facts.
--
-- `team_revision` is the compatibility key. A checkpoint is only safely continued into a run of
-- the same team file (same `sha256:` digest the run was pinned to) with its artifacts unchanged;
-- when either has moved the checkpoint is still supplied, carrying a visible "stale" note in the
-- packet's rationale rather than being dropped silently.
--
-- Existing rows predate both facts. They default to `agent` — every checkpoint written before this
-- migration came from the `checkpoint` bus tool, which only an agent can call — and to a NULL
-- revision, which reads as "unknown", never as "matches".
ALTER TABLE checkpoints
    ADD COLUMN source        TEXT NOT NULL DEFAULT 'agent'
        CHECK (source IN ('agent', 'coordinator')),
    ADD COLUMN team_revision TEXT;
