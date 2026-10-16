-- LoomWatch's archive in one SQLite file.
--
-- The same tables the PostgreSQL archive had, which `migrations/postgres/` still records and
-- `loomwatchd import-postgres` reads. What changed is only what SQLite needs: JSON is TEXT,
-- booleans are 0/1, the Notebook's full-text search is an FTS5 table, and two tables keep what
-- the session list shows so that listing never scans the whole history.
--
-- Timestamps are RFC 3339 TEXT and ids are TEXT, as before: both sort as text.

-- Append-only evidence: every ACP frame of every run, in `seq` order per session.
--
-- `payload` is the projected event as JSON text. `raw` is the exact ACP frame in the archive's
-- own encoding (`archive/codec.rs`): the frame minus the values it shares with `payload`,
-- compressed when that is smaller. It is only ever read back whole, by the daemon, which turns it
-- back into the frame it was. Never inspect it in SQL.
CREATE TABLE run_events (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    seq        INTEGER NOT NULL CHECK (seq >= 0),
    ts         TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN (
        'message', 'thought', 'tool_call', 'tool_update', 'plan',
        'permission', 'session_meta', 'usage', 'turn_end', 'process'
    )),
    payload    TEXT NOT NULL,
    raw        BLOB,
    CONSTRAINT run_events_session_seq_key UNIQUE (session_id, seq)
);

-- What `GET /api/sessions` shows for each session, kept as events are written.
--
-- The trigger below maintains it in the same statement as each insert, so it can never disagree
-- with `run_events`, whoever inserts: the daemon's batched writer, the Postgres import, or a test.
-- "First" means lowest `seq`, never insertion order, so an import that copies rows in any order
-- still lands the same summary.
CREATE TABLE run_sessions (
    session_id     TEXT PRIMARY KEY,
    started_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    event_count    INTEGER NOT NULL,
    agent_count    INTEGER NOT NULL,
    -- The lowest-seq event's agent: the entrypoint or first pipeline node.
    first_seq      INTEGER NOT NULL,
    first_agent_id TEXT NOT NULL,
    -- The first user `message`: the prompt the run was started with. `prompt` stays NULL when that
    -- message carried no text, exactly as the old lateral lookup reported it.
    prompt_seq     INTEGER,
    prompt         TEXT,
    -- The first `prompt_sections` record and its `task` section: the operator's own words.
    task_seq       INTEGER,
    task           TEXT
);

CREATE INDEX run_sessions_updated_idx ON run_sessions (updated_at DESC, session_id);

-- Which agents a session has heard from, so `agent_count` is a count of distinct agents.
CREATE TABLE run_session_agents (
    session_id TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    PRIMARY KEY (session_id, agent_id)
) WITHOUT ROWID;

CREATE TRIGGER run_events_summarise AFTER INSERT ON run_events
BEGIN
    INSERT OR IGNORE INTO run_session_agents (session_id, agent_id)
    VALUES (NEW.session_id, NEW.agent_id);

    INSERT INTO run_sessions (
        session_id, started_at, updated_at, event_count, agent_count, first_seq, first_agent_id,
        prompt_seq, prompt, task_seq, task
    )
    SELECT NEW.session_id, NEW.ts, NEW.ts, 1, 1, NEW.seq, NEW.agent_id,
           CASE WHEN is_prompt THEN NEW.seq END,
           CASE WHEN is_prompt THEN COALESCE(
               CAST(json_extract(NEW.payload, '$.content.text') AS TEXT),
               CASE WHEN json_type(NEW.payload, '$.content') = 'text'
                    THEN json_extract(NEW.payload, '$.content') END
           ) END,
           CASE WHEN is_task THEN NEW.seq END,
           CASE WHEN is_task THEN (
               SELECT CAST(json_extract(section.value, '$.text') AS TEXT)
               FROM json_each(NEW.payload, '$.sections') AS section
               WHERE json_extract(section.value, '$.kind') = 'task'
               ORDER BY section.key
               LIMIT 1
           ) END
    FROM (
        SELECT NEW.kind = 'message' AND json_extract(NEW.payload, '$.role') = 'user'
                   AS is_prompt,
               NEW.kind = 'session_meta'
                   AND json_extract(NEW.payload, '$.phase') = 'prompt_sections' AS is_task
    )
    WHERE true
    ON CONFLICT (session_id) DO UPDATE SET
        started_at = min(started_at, excluded.started_at),
        updated_at = max(updated_at, excluded.updated_at),
        event_count = event_count + 1,
        agent_count = (
            SELECT count(*) FROM run_session_agents WHERE session_id = excluded.session_id
        ),
        first_agent_id = CASE WHEN excluded.first_seq < first_seq
                              THEN excluded.first_agent_id ELSE first_agent_id END,
        first_seq = min(first_seq, excluded.first_seq),
        prompt = CASE WHEN excluded.prompt_seq < coalesce(prompt_seq, excluded.prompt_seq + 1)
                      THEN excluded.prompt ELSE prompt END,
        prompt_seq = CASE WHEN excluded.prompt_seq < coalesce(prompt_seq, excluded.prompt_seq + 1)
                          THEN excluded.prompt_seq ELSE prompt_seq END,
        task = CASE WHEN excluded.task_seq < coalesce(task_seq, excluded.task_seq + 1)
                    THEN excluded.task ELSE task END,
        task_seq = CASE WHEN excluded.task_seq < coalesce(task_seq, excluded.task_seq + 1)
                        THEN excluded.task_seq ELSE task_seq END;
END;

-- Exactly what one agent was supplied from team memory, recorded before it was sent (ADR 0014).
-- Rows are immutable. `session_id` is deliberately not a foreign key: a packet for a run that then
-- failed to spawn is evidence worth keeping.
CREATE TABLE context_packets (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    agent_id      TEXT NOT NULL,
    invocation    INTEGER NOT NULL CHECK (invocation >= 0),
    created_at    TEXT NOT NULL,
    text          TEXT NOT NULL,
    -- JSON: one entry per section, read and written only as a whole packet.
    sections      TEXT NOT NULL,
    budget_chars  INTEGER NOT NULL CHECK (budget_chars >= 0),
    used_chars    INTEGER NOT NULL CHECK (used_chars >= 0),
    CONSTRAINT context_packets_session_agent_invocation_key
        UNIQUE (session_id, agent_id, invocation)
);

-- The Notebook (docs/TEAM_MEMORY.md §6, ADR 0014). Rows are immutable: Keep, Correct and Retire
-- each insert a revision that supersedes the one it acted on. Optimistic concurrency is the
-- UNIQUE (note_key, revision) constraint, and idempotency the partial unique index below.
CREATE TABLE memory_notes (
    id                TEXT PRIMARY KEY,
    note_key          TEXT NOT NULL,
    team_id           TEXT NOT NULL,
    -- NULL once kept: the note is the team's now, and no longer belongs to one run.
    run_id            TEXT,
    author_agent_id   TEXT NOT NULL,
    origin_team_id    TEXT,
    kind              TEXT NOT NULL
        CHECK (kind IN ('decision', 'finding', 'question', 'blocker', 'progress')),
    title             TEXT NOT NULL CHECK (title <> ''),
    body              TEXT NOT NULL,
    -- JSON array of strings.
    sources           TEXT NOT NULL DEFAULT '[]',
    state             TEXT NOT NULL CHECK (state IN ('active', 'kept', 'retired')),
    revision          INTEGER NOT NULL CHECK (revision >= 1),
    supersedes        TEXT REFERENCES memory_notes (id),
    revised_by        TEXT NOT NULL,
    idempotency_key   TEXT,
    created_at        TEXT NOT NULL,
    CONSTRAINT memory_notes_revision_key UNIQUE (note_key, revision)
);

CREATE INDEX memory_notes_team_idx ON memory_notes (team_id, state, kind);
CREATE INDEX memory_notes_run_idx ON memory_notes (run_id, author_agent_id);
-- "Is this revision current?" is `NOT EXISTS (… WHERE newer.supersedes = n.id)` on every
-- Notebook read; without this index each row of a read scanned the whole table.
CREATE INDEX memory_notes_supersedes_idx ON memory_notes (supersedes)
    WHERE supersedes IS NOT NULL;
CREATE UNIQUE INDEX memory_notes_idempotency_idx
    ON memory_notes (team_id, author_agent_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- `memory_search` over title and body. Its own copy of the two columns, joined back by `note_id`,
-- rather than an external-content table keyed by rowid: VACUUM (and every backup, which is a
-- `VACUUM INTO`) may renumber the rowids of a table whose key is TEXT. Notes are small and never
-- change, so the copy costs little and cannot drift.
CREATE VIRTUAL TABLE memory_notes_search USING fts5(
    note_id UNINDEXED,
    title,
    body,
    tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER memory_notes_search_insert AFTER INSERT ON memory_notes
BEGIN
    INSERT INTO memory_notes_search (note_id, title, body) VALUES (NEW.id, NEW.title, NEW.body);
END;

CREATE TRIGGER memory_notes_search_delete AFTER DELETE ON memory_notes
BEGIN
    DELETE FROM memory_notes_search WHERE note_id = OLD.id;
END;

-- Every Notebook mutation's audit row, written in the same transaction as the revision.
CREATE TABLE memory_audit (
    id         TEXT PRIMARY KEY,
    ts         TEXT NOT NULL,
    team_id    TEXT NOT NULL,
    note_id    TEXT NOT NULL,
    action     TEXT NOT NULL CHECK (action IN ('write', 'keep', 'correct', 'retire', 'import')),
    actor      TEXT NOT NULL,
    run_id     TEXT,
    -- JSON object.
    detail     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX memory_audit_note_idx ON memory_audit (note_id, ts);

-- Structured progress for one agent at one boundary (TEAM_MEMORY.md channel 4).
CREATE TABLE checkpoints (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    invocation      INTEGER NOT NULL CHECK (invocation >= 0),
    done            TEXT NOT NULL,
    next            TEXT NOT NULL,
    blockers        TEXT,
    -- JSON: `[{"path": …, "sha256": …}]`.
    artifacts       TEXT NOT NULL DEFAULT '[]',
    seq_high_water  INTEGER,
    ts              TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'coordinator')),
    team_revision   TEXT,
    CONSTRAINT checkpoints_run_agent_invocation_key UNIQUE (run_id, agent_id, invocation)
);

-- Run records, so run lineage survives a restart (ADR 0015). Mutable state about one run, unlike
-- the append-only `run_events`.
CREATE TABLE runs (
    run_id            TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    team_path         TEXT NOT NULL,
    prompt            TEXT NOT NULL,
    status            TEXT NOT NULL
        CHECK (status IN ('queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled')),
    mode              TEXT NOT NULL CHECK (mode IN ('team', 'pipeline')),
    entrypoint        TEXT NOT NULL,
    responder         TEXT NOT NULL,
    -- JSON array of agent ids in file order.
    agent_ids         TEXT NOT NULL DEFAULT '[]',
    created_at        TEXT NOT NULL,
    started_at        TEXT,
    finished_at       TEXT,
    error             TEXT,
    exit_code         INTEGER,
    error_code        TEXT,
    stop_reason       TEXT,
    event_count       INTEGER,
    reply             TEXT,
    trigger           TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule')),
    -- JSON.
    delivery          TEXT,
    follows_run_id    TEXT,
    start_at          TEXT,
    retry_of_run_id   TEXT,
    -- JSON: `{node, agent, since, question}` while the run waits.
    waiting_on        TEXT,
    start_key         TEXT,
    start_fingerprint TEXT,
    -- ADR 0051: the team file's `id`, or `path:<team_path>`.
    team_key          TEXT,
    only_agent        TEXT,
    -- The `sha256:` digest of the team file the run executed.
    team_revision     TEXT
);

CREATE INDEX runs_created_idx ON runs (created_at DESC, run_id);
CREATE INDEX runs_follows_idx ON runs (follows_run_id) WHERE follows_run_id IS NOT NULL;
CREATE INDEX runs_retry_idx ON runs (retry_of_run_id) WHERE retry_of_run_id IS NOT NULL;
CREATE UNIQUE INDEX runs_start_key_idx ON runs (start_key) WHERE start_key IS NOT NULL;
CREATE INDEX runs_team_key_created_idx ON runs (team_key, created_at DESC);
CREATE INDEX runs_team_path_created_idx ON runs (team_path, created_at DESC);

-- The queue behind "waiting for you" (TEAM_MEMORY.md §6, Canvas C).
CREATE TABLE operator_questions (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    question        TEXT NOT NULL CHECK (question <> ''),
    context         TEXT,
    asked_at        TEXT NOT NULL,
    -- NULL is the whole definition of "open".
    answered_at     TEXT,
    answer_event_id TEXT
);

-- One open question per agent at a time, enforced by the storage even if two calls race.
CREATE UNIQUE INDEX operator_questions_one_open_idx
    ON operator_questions (run_id, agent_id)
    WHERE answered_at IS NULL;
CREATE INDEX operator_questions_run_idx ON operator_questions (run_id, asked_at);

-- ADR 0051: what the operator typed into a team's chat.
CREATE TABLE chat_messages (
    id            TEXT PRIMARY KEY,
    team_key      TEXT NOT NULL,
    team_path     TEXT NOT NULL,
    text          TEXT NOT NULL CHECK (text <> ''),
    created_at    TEXT NOT NULL,
    route         TEXT NOT NULL CHECK (route IN ('team', 'agent', 'note', 'team_note')),
    run_id        TEXT,
    agent_id      TEXT,
    delivered_at  TEXT,
    now           BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX chat_messages_team_created_idx ON chat_messages (team_key, created_at DESC);
CREATE INDEX chat_messages_run_idx ON chat_messages (run_id);

-- Each `loomwatchd import-postgres` that copied rows into this file: when, from which database
-- (without its password), and how many rows were new.
CREATE TABLE imports (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    imported_at  TEXT NOT NULL,
    rows_copied  INTEGER NOT NULL,
    rows_skipped INTEGER NOT NULL
);
