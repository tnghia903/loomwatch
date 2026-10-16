-- ADR 0051: each team's runs read as one chat.
--
-- The chat is the team's runs in time order, so it needs to find them by team. `team_path` is not
-- enough: renaming or moving the file would split the chat in two. `team_key` is the team file's
-- `id`, or `path:<team_path>` for a file with none; rows written before this column existed are
-- found by their path.
ALTER TABLE runs ADD COLUMN team_key TEXT;
-- A one-agent turn: the one agent the operator wrote to with an @mention.
ALTER TABLE runs ADD COLUMN only_agent TEXT;

CREATE INDEX runs_team_key_created_idx ON runs (team_key, created_at DESC);
CREATE INDEX runs_team_path_created_idx ON runs (team_path, created_at DESC);

-- What the operator typed into a team's chat. Every message is kept, whatever became of it: a
-- message that started work points at its run, a note to an agent at work points at the run it
-- joined, and a team note points at nothing until the next work reads it as conversation.
CREATE TABLE chat_messages (
    id            TEXT PRIMARY KEY,
    team_key      TEXT NOT NULL,
    team_path     TEXT NOT NULL,
    text          TEXT NOT NULL CHECK (text <> ''),
    created_at    TEXT NOT NULL,
    -- How the message was routed, decided by the daemon at the moment it arrived:
    --   team       @team: the whole team started on it (run_id)
    --   agent      @<agent>, idle: a one-agent turn (run_id, agent_id)
    --   note       to an agent at work: queued for its next turn (run_id, agent_id)
    --   team_note  no @ and nobody working: starts nothing, read as conversation next time
    route         TEXT NOT NULL CHECK (route IN ('team', 'agent', 'note', 'team_note')),
    run_id        TEXT,
    agent_id      TEXT,
    -- A note's delivery: stamped when the agent's next turn took it. NULL on a note means it is
    -- still waiting, or its run ended first and it stays in the chat as conversation.
    delivered_at  TEXT,
    -- "Send now": the note asked to stop the agent's turn rather than wait for it.
    now           BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX chat_messages_team_created_idx ON chat_messages (team_key, created_at DESC);
CREATE INDEX chat_messages_run_idx ON chat_messages (run_id);
