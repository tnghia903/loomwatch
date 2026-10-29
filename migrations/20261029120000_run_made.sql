-- The files a run's agents made: what their edit calls name, of those that went through, worked out
-- from the run's archived tool calls once it ends. JSON list of paths; NULL until it is worked out,
-- which for a run from before this column happens once, in the background, after the daemon starts.
ALTER TABLE runs ADD COLUMN made TEXT;
