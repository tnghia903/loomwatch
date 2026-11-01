-- The agent that asked for a run, when one did rather than the person: the agent pinned to the
-- notch, asking one of the person's teams from its own chat (ADR 0083, decision 10). JSON
-- `{agent, name}`; NULL for a run the person or a schedule started, and for runs from before it.
ALTER TABLE runs ADD COLUMN asked_by TEXT;
