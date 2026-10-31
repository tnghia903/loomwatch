-- Changes a person left on a file an agent made, for an agent to make (ADR 0107): marked on a part
-- of the file in the reader (`part`, the chat's JSON `ReplyTo` of kind `passage`), with what should
-- change there as they typed it (`words`) and the pictures of the part sent in the team's chat
-- (`files`, a JSON list of `{path}`). A change waits on its file until Send (`waiting`), then waits
-- for its agent's turn on that file (`queued`, its message fixed in `message_id` and its place in
-- that message in `number`), then is in that turn (`sent`, with its `run_id`). `kept` is the copy of
-- the file kept before that turn, which puts the change back. Filed by the team's chat key, with
-- its path as for the chat (crates/loomwatch-backend/src/changes.rs).
CREATE TABLE file_changes (
    id         TEXT PRIMARY KEY,
    team_key   TEXT NOT NULL,
    team_path  TEXT NOT NULL,
    file       TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    words      TEXT NOT NULL,
    part       TEXT NOT NULL,
    files      TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    state      TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'queued', 'sent')),
    message_id TEXT,
    run_id     TEXT,
    kept       TEXT,
    number     INTEGER
);

CREATE INDEX file_changes_by_file ON file_changes (file, state, created_at);
CREATE INDEX file_changes_by_team ON file_changes (team_key, created_at);

-- The changes a chat message sends to its agent (ADR 0107): each one's id, its number in the
-- message, what should change and the part it is about, so the chat shows them. JSON; NULL for any
-- other message, and for every message sent before changes.
ALTER TABLE chat_messages ADD COLUMN changes TEXT;
