-- Run records, so run lineage survives a daemon restart.
--
-- See docs/decisions/0015-runs-table.md. Until now `RunRegistry` was a `BTreeMap` behind an
-- `RwLock` that lived exactly as long as the process: restarting the daemon lost every run's
-- status, its reply, which run it was a retry of, and the start keys that make a resubmitted
-- request idempotent. `run_events` still held the evidence, but nothing held the *record*, which
-- is why `mergeHistory` in the UI has a `legacyOperatorPrompt` fallback for runs the daemon has
-- forgotten.
--
-- This table is the record. `run_events` is untouched and remains the append-only evidence; a row
-- here is mutable state about one run (its status moves forward, its delivery is stamped after it
-- finishes) and is deliberately a different thing from an event.
CREATE TABLE runs (
    -- Minted by LoomWatch before any process exists, and equal to `session_id`: the archive
    -- session every event of this run lands under.
    run_id            TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    -- Normalised path relative to the teams root, `/`-separated.
    team_path         TEXT NOT NULL,
    prompt            TEXT NOT NULL,
    status            TEXT NOT NULL
        CHECK (status IN ('queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled')),
    mode              TEXT NOT NULL CHECK (mode IN ('team', 'pipeline')),
    entrypoint        TEXT NOT NULL,
    responder         TEXT NOT NULL,
    -- Agent ids in file order. JSONB because they are read and written only as a whole record.
    agent_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
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
    delivery          JSONB,

    -- Lineage. All three are columns and record fields in this change and have no behaviour yet:
    -- `POST /api/runs` gains `followsRunId`/`startAt` in Canvas B, which replays earlier stages
    -- from `context_packets` instead of re-running them. Shipping the columns first means that
    -- change is a handler change rather than a migration plus a handler change.
    --
    -- The run this one continues from. Its stages before `start_at` are replayed, not re-run.
    follows_run_id    TEXT,
    -- The stage id a follow-up starts executing at. NULL means "from the beginning".
    start_at          TEXT,
    -- The run this one is a retry of. Retry is the explicit from-zero action, so this is lineage
    -- for the history thread and never a replay instruction. It was client-side state in a React
    -- `Map` before this table, which is to say it did not survive a page reload either.
    retry_of_run_id   TEXT,
    -- What the run is waiting for, when it is waiting: `{node, agent, since, question}`. The
    -- queue behind "waiting for you" has to survive a restart or an operator comes back to a run
    -- that is stopped for a reason nothing remembers.
    waiting_on        JSONB,

    -- One key for the lifetime of a submit attempt, bound to the exact request it was submitted
    -- with. Persisted so a resubmit after a restart is still recognised as a duplicate rather
    -- than starting a second run.
    start_key         TEXT,
    start_fingerprint TEXT
);

-- The history list, newest first.
CREATE INDEX runs_created_idx ON runs (created_at DESC, run_id);
-- Lineage lookups: "what followed this run", "what retried it".
CREATE INDEX runs_follows_idx ON runs (follows_run_id) WHERE follows_run_id IS NOT NULL;
CREATE INDEX runs_retry_idx ON runs (retry_of_run_id) WHERE retry_of_run_id IS NOT NULL;
-- A start key binds to at most one run. Scoped to the loopback principal, which LoomWatch has
-- exactly one of; when authentication lands this becomes `(principal, start_key)`.
CREATE UNIQUE INDEX runs_start_key_idx ON runs (start_key) WHERE start_key IS NOT NULL;
