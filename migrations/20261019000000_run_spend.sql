-- What a run spent and may spend (ADR 0068): its spool, each agent's share and guard, and what the
-- operator added. JSON; NULL for runs recorded before spend limits.
ALTER TABLE runs ADD COLUMN spend TEXT;
