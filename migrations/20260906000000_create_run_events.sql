CREATE TABLE run_events (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    seq        BIGINT NOT NULL CHECK (seq >= 0),
    ts         TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN (
        'message', 'thought', 'tool_call', 'tool_update', 'plan',
        'permission', 'session_meta', 'usage', 'turn_end', 'process'
    )),
    payload    JSONB NOT NULL,
    raw        JSONB,
    CONSTRAINT run_events_session_seq_key UNIQUE (session_id, seq)
);
