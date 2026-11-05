-- Where a widget stands in its answer (ADR 0114): the line of the answer's words it is drawn
-- before, once the agent's place line (`{{widget N}}`) is taken out of them. NULL for a widget the
-- answer didn't place, and for every widget kept before this, which are drawn at the end.
ALTER TABLE widgets ADD COLUMN line INTEGER;
