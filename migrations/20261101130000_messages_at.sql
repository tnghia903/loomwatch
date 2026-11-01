-- Messages an agent in its own chat set for the person, at a time they asked (ADR 0108). Each waits
-- until `at` (RFC 3339, UTC), when the agent takes one turn in that chat and writes it. `run_id` is
-- that turn; a cancelled message, or one whose chat is gone, never gets one.
CREATE TABLE messages_at (
    id         TEXT PRIMARY KEY,
    chat_path  TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    at         TEXT NOT NULL,
    text       TEXT NOT NULL,
    set_at     TEXT NOT NULL,
    set_in_run TEXT,
    status     TEXT NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting', 'sent', 'cancelled', 'failed')),
    run_id     TEXT
);

CREATE INDEX messages_at_waiting ON messages_at (status, at);

-- The message a run was started for, `{id, at, text}` as JSON: the chat draws its start as a
-- reminder and the phone is told the agent's message. NULL for every other run.
ALTER TABLE runs ADD COLUMN message_at TEXT;
