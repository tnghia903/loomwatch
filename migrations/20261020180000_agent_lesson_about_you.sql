-- A lesson about the person rather than one job ("When replying to this person, always write in
-- Vietnamese"), as the learner marked it (ADR 0078, "Tell all my agents"). The chat and the builder
-- offer to put such a lesson in About you (ADR 0074), which every agent reads, and only when the
-- person says so. Then it leaves the agent's own list: `state` `dropped`, `dropped_by` `about_you`.
ALTER TABLE agent_lessons ADD COLUMN about_you INTEGER NOT NULL DEFAULT 0;
-- 1 when Tell all my agents added the lesson's sentence to About you; 0 when About you already said
-- it, or the lesson was never told. Undo takes out only a line it added.
ALTER TABLE agent_lessons ADD COLUMN added_to_about_you INTEGER NOT NULL DEFAULT 0;
