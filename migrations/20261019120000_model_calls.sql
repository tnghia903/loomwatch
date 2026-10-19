-- One row per model call, for the Usage page (ADR 0073): which source paid, how many tokens, and
-- what it cost. Every call is already archived as a `usage` event carrying its own record in
-- `_meta.loomwatch.call`; the trigger below copies that record here in the same statement, so the
-- ledger can never disagree with `run_events`, whoever inserts. Ask's calls are archived the same
-- way, so they are counted too.
--
-- `source` is `openrouter`, `chatgpt` or `anthropic`; calls recorded before other sources existed
-- have no `paidBy` and were all OpenRouter's. A ChatGPT plan's calls cost the plan's allowance, not
-- dollars, so their `cost_usd` is 0. `cost_estimated` marks a cost worked out from list prices.
CREATE TABLE model_calls (
    event_id            TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    agent_id            TEXT NOT NULL,
    ts                  TEXT NOT NULL,
    source              TEXT NOT NULL,
    model               TEXT NOT NULL,
    -- `work`, `carry_on`, `summary` or `bare_summary`.
    call_kind           TEXT,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    cached_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cached_write_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_usd            REAL NOT NULL DEFAULT 0,
    cost_estimated      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX model_calls_ts_idx ON model_calls (ts);
CREATE INDEX model_calls_source_ts_idx ON model_calls (source, ts);

CREATE TRIGGER run_events_model_call AFTER INSERT ON run_events
WHEN NEW.kind = 'usage'
    AND json_extract(NEW.payload, '$._meta.loomwatch.call.model') IS NOT NULL
BEGIN
    INSERT OR IGNORE INTO model_calls (
        event_id, session_id, agent_id, ts, source, model, call_kind, input_tokens,
        cached_read_tokens, cached_write_tokens, output_tokens, reasoning_tokens, cost_usd,
        cost_estimated
    ) VALUES (
        NEW.id,
        NEW.session_id,
        NEW.agent_id,
        NEW.ts,
        COALESCE(json_extract(NEW.payload, '$._meta.loomwatch.call.paidBy'), 'openrouter'),
        json_extract(NEW.payload, '$._meta.loomwatch.call.model'),
        json_extract(NEW.payload, '$._meta.loomwatch.call.kind'),
        COALESCE(json_extract(NEW.payload, '$._meta.loomwatch.call.inputTokens'), 0),
        COALESCE(json_extract(NEW.payload, '$._meta.loomwatch.call.cachedReadTokens'), 0),
        COALESCE(json_extract(NEW.payload, '$._meta.loomwatch.call.cachedWriteTokens'), 0),
        COALESCE(json_extract(NEW.payload, '$._meta.loomwatch.call.outputTokens'), 0),
        COALESCE(json_extract(NEW.payload, '$._meta.loomwatch.call.reasoningTokens'), 0),
        COALESCE(json_extract(NEW.payload, '$._meta.loomwatch.call.costUsd'), 0),
        COALESCE(json_extract(NEW.payload, '$._meta.loomwatch.call.costEstimated'), 0)
    );
END;

-- The calls already archived: all OpenRouter's.
INSERT OR IGNORE INTO model_calls (
    event_id, session_id, agent_id, ts, source, model, call_kind, input_tokens, cached_read_tokens,
    cached_write_tokens, output_tokens, reasoning_tokens, cost_usd, cost_estimated
)
SELECT
    id,
    session_id,
    agent_id,
    ts,
    COALESCE(json_extract(payload, '$._meta.loomwatch.call.paidBy'), 'openrouter'),
    json_extract(payload, '$._meta.loomwatch.call.model'),
    json_extract(payload, '$._meta.loomwatch.call.kind'),
    COALESCE(json_extract(payload, '$._meta.loomwatch.call.inputTokens'), 0),
    COALESCE(json_extract(payload, '$._meta.loomwatch.call.cachedReadTokens'), 0),
    COALESCE(json_extract(payload, '$._meta.loomwatch.call.cachedWriteTokens'), 0),
    COALESCE(json_extract(payload, '$._meta.loomwatch.call.outputTokens'), 0),
    COALESCE(json_extract(payload, '$._meta.loomwatch.call.reasoningTokens'), 0),
    COALESCE(json_extract(payload, '$._meta.loomwatch.call.costUsd'), 0),
    COALESCE(json_extract(payload, '$._meta.loomwatch.call.costEstimated'), 0)
FROM run_events
WHERE kind = 'usage' AND json_extract(payload, '$._meta.loomwatch.call.model') IS NOT NULL;
