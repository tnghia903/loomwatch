-- A built-in agent's conversation while it waits between turns (parked), so a run can pick it up
-- again, even after the daemon restarts. `snapshot` is the agent's `Snapshot` as JSON, compressed
-- with zstd. Removed when the run ends.
CREATE TABLE agent_sessions (
    session_id TEXT PRIMARY KEY,
    run_session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    snapshot BLOB NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX agent_sessions_by_run ON agent_sessions (run_session_id);
