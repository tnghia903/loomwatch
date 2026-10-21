-- Finding words in a team's earlier work (ADR 0081): every request, answer, note and line of the
-- agents' talk, cut into passages of at most 1,200 characters (`chat_find.rs`).
--
-- `piece` is the run id for a piece of work, or the message id for a team note. `target` names
-- what in the piece was said, as the chat names it: `request`, `answer`, `note:<id>`,
-- `talk:<line>` or `reply:<agent>`. `who` is the agent who said it; NULL for the person.
CREATE TABLE work_passages (
    id         INTEGER PRIMARY KEY,
    piece      TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('work', 'note')),
    team_key   TEXT NOT NULL,
    team_path  TEXT NOT NULL,
    piece_at   TEXT NOT NULL,
    target     TEXT NOT NULL,
    who        TEXT,
    said_at    TEXT NOT NULL,
    part       INTEGER NOT NULL,
    text       TEXT NOT NULL
);

CREATE INDEX work_passages_piece_idx ON work_passages (piece);

-- The words of each passage, folded by `LoomWatch` (lower case, accents off, đ as d) before they
-- are written, because `remove_diacritics` leaves đ alone. Its rowid is the passage's id, an
-- INTEGER PRIMARY KEY that VACUUM keeps.
CREATE VIRTUAL TABLE work_passages_search USING fts5(
    folded,
    tokenize = 'unicode61 remove_diacritics 0'
);

-- What needs indexing, kept by the triggers below so no way of writing a run or a message is
-- missed. `version` goes up each time a piece is queued again, so the indexer only takes off the
-- queue the version it read.
CREATE TABLE work_index_queue (
    piece   TEXT PRIMARY KEY,
    kind    TEXT NOT NULL CHECK (kind IN ('work', 'note')),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TRIGGER work_index_run_insert AFTER INSERT ON runs
BEGIN
    INSERT INTO work_index_queue (piece, kind) VALUES (NEW.run_id, 'work')
        ON CONFLICT (piece) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER work_index_run_update AFTER UPDATE ON runs
WHEN NEW.status IS NOT OLD.status OR NEW.reply IS NOT OLD.reply OR NEW.prompt IS NOT OLD.prompt
BEGIN
    INSERT INTO work_index_queue (piece, kind) VALUES (NEW.run_id, 'work')
        ON CONFLICT (piece) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER work_index_run_delete AFTER DELETE ON runs
BEGIN
    INSERT INTO work_index_queue (piece, kind) VALUES (OLD.run_id, 'work')
        ON CONFLICT (piece) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER work_index_message_insert AFTER INSERT ON chat_messages
BEGIN
    INSERT INTO work_index_queue (piece, kind)
        VALUES (COALESCE(NEW.run_id, NEW.id), CASE WHEN NEW.run_id IS NULL THEN 'note' ELSE 'work' END)
        ON CONFLICT (piece) DO UPDATE SET version = version + 1;
END;

-- A team note that starts work becomes that work's request; one the agents answer gains their
-- answers. Both the note and its work are indexed again.
CREATE TRIGGER work_index_message_update AFTER UPDATE ON chat_messages
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.answers IS NOT OLD.answers OR NEW.text IS NOT OLD.text
BEGIN
    INSERT INTO work_index_queue (piece, kind) VALUES (NEW.id, 'note')
        ON CONFLICT (piece) DO UPDATE SET version = version + 1;
    INSERT INTO work_index_queue (piece, kind)
        SELECT NEW.run_id, 'work' WHERE NEW.run_id IS NOT NULL
        ON CONFLICT (piece) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER work_index_message_delete AFTER DELETE ON chat_messages
BEGIN
    INSERT INTO work_index_queue (piece, kind)
        VALUES (COALESCE(OLD.run_id, OLD.id), CASE WHEN OLD.run_id IS NULL THEN 'note' ELSE 'work' END)
        ON CONFLICT (piece) DO UPDATE SET version = version + 1;
END;

-- Everything already in the chat, newest first, for the indexer to fill in after the update.
INSERT INTO work_index_queue (piece, kind)
    SELECT run_id, 'work' FROM runs ORDER BY created_at DESC;
INSERT INTO work_index_queue (piece, kind)
    SELECT id, 'note' FROM chat_messages
    WHERE run_id IS NULL AND route = 'team_note'
    ON CONFLICT (piece) DO NOTHING;
