-- Exactly what one agent was supplied from team memory, recorded before it was sent.
--
-- `run_events` is untouched by design (docs/WEBSOCKET_SCHEMA.md is frozen). This table is the
-- record the packet inspector reads, so the UI never has to re-derive what an agent was given by
-- parsing the prompt back out of the archive — which is what it used to do, and what broke the
-- moment a new prompt section was added. See docs/TEAM_MEMORY.md and ADR 0014.
--
-- Rows are immutable: a packet is the exact bytes of one opening prompt's memory section, so a
-- second invocation of the same agent in the same run is a new row, not an update.
CREATE TABLE context_packets (
    id            TEXT PRIMARY KEY,
    -- The archive session, i.e. the run. Not a foreign key: `run_events` rows for a session
    -- arrive after the packet is stored, and a packet for a run that then failed to spawn is
    -- evidence worth keeping, not an orphan to cascade away.
    session_id    TEXT NOT NULL,
    agent_id      TEXT NOT NULL,
    -- Which turn of this agent in this run the packet opened. 0 is its first; a delegated helper
    -- called twice has one row per call.
    invocation    INTEGER NOT NULL CHECK (invocation >= 0),
    created_at    TEXT NOT NULL,
    -- The rendered `## What the team knows` section, verbatim.
    text          TEXT NOT NULL,
    -- One entry per section with its kind, label, character count, selection rationale, and the
    -- Brief file path plus content hash it came from. JSONB rather than a child table: the
    -- sections are read and written only as a whole packet, and their shape grows as later phases
    -- add notebook, checkpoint and direction sections.
    sections      JSONB NOT NULL,
    budget_chars  INTEGER NOT NULL CHECK (budget_chars >= 0),
    used_chars    INTEGER NOT NULL CHECK (used_chars >= 0),
    CONSTRAINT context_packets_session_agent_invocation_key
        UNIQUE (session_id, agent_id, invocation)
);

-- The inspector asks for one run's packets, optionally narrowed to one agent.
CREATE INDEX context_packets_session_idx ON context_packets (session_id, agent_id, invocation);
