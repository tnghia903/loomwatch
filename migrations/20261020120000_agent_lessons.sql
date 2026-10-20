-- What an agent learned from the person's feedback on its work (ADR 0078): one sentence each,
-- given to the agent in its standing instructions from its next session on.
--
-- A lesson is made only from something outside the agent: the person's own words about a piece of
-- its work, an answer they marked Love it, or a check step that found a Done when item not met and
-- then met after the send-back. Never from the agent's view of its own work.
--
-- `scope` is whose lesson it is: `agent:<id>` for one of My agents, shared by its own chat and by
-- every team that places it; `team:<memory scope>#<agent id>` for a team's own agent. `agent_id`
-- and `run_id` say where it was learned, so the chat can show it on the work it came from.
--
-- A changed lesson is a new row that `replaces` the old, which turns `replaced`; undoing the change
-- brings the old one back. Nothing is deleted: a dropped lesson stays readable.
CREATE TABLE agent_lessons (
    id         TEXT PRIMARY KEY,
    scope      TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    text       TEXT NOT NULL,
    -- `you`: the person's words. `check`: a check step's missed-then-met item. `liked`: what made
    -- an answer the person marked Love it right.
    source     TEXT NOT NULL CHECK (source IN ('you', 'check', 'liked')),
    -- What it was learned from, as the person sees it: their words, or the check item, cut.
    feedback   TEXT NOT NULL,
    -- The piece of work the feedback was about.
    run_id     TEXT,
    state      TEXT NOT NULL CHECK (state IN ('active', 'dropped', 'replaced')),
    replaces   TEXT,
    -- Who dropped it: `you`, `learning` (a later lesson said it was wrong), or `room` (the list was
    -- full and it was the least backed).
    dropped_by TEXT,
    -- Later feedback said the agent did it again although it had this lesson.
    missed     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX agent_lessons_scope_idx ON agent_lessons (scope, state);
CREATE INDEX agent_lessons_run_idx ON agent_lessons (run_id);

-- Which lessons each piece of work was given, so a face the person puts on its answer backs the
-- lessons it was given, and taking the face off takes that back.
CREATE TABLE agent_lesson_uses (
    lesson_id TEXT NOT NULL,
    run_id    TEXT NOT NULL,
    agent_id  TEXT NOT NULL,
    backed    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lesson_id, run_id)
);

CREATE INDEX agent_lesson_uses_run_idx ON agent_lesson_uses (run_id);
