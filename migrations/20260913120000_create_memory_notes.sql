-- The Notebook: what agents observe during a run, and what the operator lets outlive it.
--
-- `docs/TEAM_MEMORY.md` §6 (Storage) and §9 (Trust boundary), decided by ADR 0014. Three
-- properties are structural here rather than enforced in Rust, because a crash between two
-- statements must not be able to produce a note the panel shows and a packet never contained:
--
--  1. **Rows are immutable.** Keep, Correct and Retire each INSERT a new revision that supersedes
--     the one it acted on; nothing is ever UPDATEd. A note's history is therefore the family of
--     rows sharing its `note_key`, and "the note as it stands" is the highest revision in that
--     family. This is what lets a stored `context_packets` row keep naming the exact revision it
--     supplied after the operator corrects it.
--  2. **Optimistic concurrency is the UNIQUE (note_key, revision) index**, not a read-then-write
--     in the daemon. Two corrections racing from revision 2 both try to insert revision 3; one
--     wins and the other gets a unique violation, which `memory.rs` reports as a conflict.
--  3. **Idempotency is a partial UNIQUE index.** A `memory_write` retried with the same
--     `idempotencyKey` collides and the store returns the row already there, so a harness that
--     retries a timed-out tool call cannot duplicate a note.
CREATE TABLE memory_notes (
    id                TEXT PRIMARY KEY,
    -- The note's identity across revisions. Revision 1 sets it to its own id; every later
    -- revision of the same note carries it unchanged, so `WHERE note_key = $1` is the history.
    note_key          TEXT NOT NULL,
    -- The memory scope. The team's `id` from the team file, never its path: renaming a team keeps
    -- its memory, and a duplicated file with the same id shares it (TEAM_MEMORY.md §5).
    team_id           TEXT NOT NULL,
    -- The run the note was written in. NULL once kept, which is exactly what "kept" means: the
    -- note is the team's now, and no longer belongs to one run.
    run_id            TEXT,
    -- Who wrote it. Derived from the bus token's `AgentSession`, never from tool arguments.
    author_agent_id   TEXT NOT NULL,
    -- The origin team for an inherited note, so the panel and the packet can attribute it. NULL
    -- for the team's own notes.
    origin_team_id    TEXT,
    kind              TEXT NOT NULL
        CHECK (kind IN ('decision', 'finding', 'question', 'blocker', 'progress')),
    title             TEXT NOT NULL CHECK (title <> ''),
    body              TEXT NOT NULL,
    -- Where the claim came from, as the agent cited it: an array of strings. JSONB rather than a
    -- child table because sources are read and written only as part of one note.
    sources           JSONB NOT NULL DEFAULT '[]'::jsonb,
    state             TEXT NOT NULL CHECK (state IN ('active', 'kept', 'retired')),
    revision          INTEGER NOT NULL CHECK (revision >= 1),
    -- The row this revision replaces. NULL on revision 1.
    supersedes        TEXT REFERENCES memory_notes (id),
    -- Who made this revision: an agent id for a write, 'operator' for Keep/Correct/Retire.
    revised_by        TEXT NOT NULL,
    idempotency_key   TEXT,
    created_at        TEXT NOT NULL,
    -- Postgres full-text search over title and body, which is what `memory_search` runs. A
    -- generated column rather than a trigger: `to_tsvector(regconfig, text)` is IMMUTABLE, so the
    -- index cannot drift from the row.
    search            tsvector GENERATED ALWAYS AS (
                          to_tsvector('english', title || ' ' || body)
                      ) STORED,
    CONSTRAINT memory_notes_revision_key UNIQUE (note_key, revision)
);

CREATE INDEX memory_notes_search_idx ON memory_notes USING GIN (search);
-- The two reads that matter: one team's notebook, and one run's notes.
CREATE INDEX memory_notes_team_idx ON memory_notes (team_id, state, kind);
CREATE INDEX memory_notes_run_idx ON memory_notes (run_id, author_agent_id);
CREATE UNIQUE INDEX memory_notes_idempotency_idx
    ON memory_notes (team_id, author_agent_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Every mutation's audit row, written in the same transaction as the revision it describes.
CREATE TABLE memory_audit (
    id         TEXT PRIMARY KEY,
    ts         TEXT NOT NULL,
    team_id    TEXT NOT NULL,
    -- The revision this row describes. Not a foreign key on purpose: the audit trail outlives
    -- any future retention policy on the notes themselves.
    note_id    TEXT NOT NULL,
    action     TEXT NOT NULL CHECK (action IN ('write', 'keep', 'correct', 'retire', 'import')),
    -- The agent id for a tool write, 'operator' for a panel action.
    actor      TEXT NOT NULL,
    run_id     TEXT,
    detail     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX memory_audit_note_idx ON memory_audit (note_id, ts);

-- Structured progress for one agent at one boundary (TEAM_MEMORY.md channel 4).
--
-- Phase 2 ships the table and the `checkpoint` bus tool. The coordinator-requested checkpoint at
-- every stage boundary, and "Start a new run from this checkpoint", are memory phase 3 — the rows
-- are already the shape that needs, so phase 3 adds callers rather than a migration.
CREATE TABLE checkpoints (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    -- Which turn of this agent in this run wrote it; allocated the same way `context_packets`
    -- allocates its own, so a helper called twice has one row per call.
    invocation      INTEGER NOT NULL CHECK (invocation >= 0),
    done            TEXT NOT NULL,
    next            TEXT NOT NULL,
    blockers        TEXT,
    -- Paths and content hashes of what the agent produced: `[{"path": …, "sha256": …}]`.
    -- Continuation compatibility is checked against these.
    artifacts       JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- The archive `seq` the run had reached when this was written, so a continuation can say
    -- exactly how much evidence the checkpoint covers.
    seq_high_water  BIGINT,
    ts              TEXT NOT NULL,
    CONSTRAINT checkpoints_run_agent_invocation_key UNIQUE (run_id, agent_id, invocation)
);

CREATE INDEX checkpoints_run_idx ON checkpoints (run_id, agent_id, invocation);
