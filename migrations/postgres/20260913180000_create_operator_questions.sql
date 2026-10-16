-- The queue behind "waiting for you" (docs/TEAM_MEMORY.md §6, Canvas C).
--
-- Two things park a run on the person at the keyboard, and they are the same fact with different
-- authors: a **review stop** the operator designed (an `agents[]` entry with `kind: operator`, so
-- the pipeline reaches it in topological order and there is no harness to spawn), and an
-- **`ask_user`** call an agent made mid-turn. Both record a row here, both set the run record's
-- `waiting_on`, and both are answered by `POST /api/runs/{id}/answers`.
--
-- This is not a `run_events` row. The *answer* is evidence and lands in `run_events` as a user
-- `message` from the operator node's id; what lives here is the open question — mutable state with
-- an `answered_at` that gets stamped — which is the same reason `runs` is not `run_events`.
CREATE TABLE operator_questions (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL,
    -- The operator node of a review stop, or the agent that called `ask_user`. One column because
    -- "who is this question attached to" has one answer, and the run's team file says which of the
    -- two kinds that id is.
    agent_id        TEXT NOT NULL,
    -- What the person is being asked. An operator node's `role`, or the `question` argument.
    question        TEXT NOT NULL CHECK (question <> ''),
    -- `ask_user`'s optional `context`, and the handover a review stop displays. Never required:
    -- a question that only makes sense with context is a question the agent asked badly, and the
    -- panel shows the run beside it either way.
    context         TEXT,
    asked_at        TEXT NOT NULL,
    -- Stamped when the answer is accepted. NULL is the whole definition of "open".
    answered_at     TEXT,
    -- The `run_events.id` of the archived user `message` that answered it, so the question and the
    -- evidence it produced can be read as one thing.
    answer_event_id TEXT
);

-- "One open question per agent at a time" (§6), enforced here rather than only in the bus: a
-- second `ask_user` from an agent that is already waiting must be refused even if two calls race.
CREATE UNIQUE INDEX operator_questions_one_open_idx
    ON operator_questions (run_id, agent_id)
    WHERE answered_at IS NULL;

-- The two reads: one run's queue, and every open question across runs (the Attention panel).
CREATE INDEX operator_questions_run_idx ON operator_questions (run_id, asked_at);
