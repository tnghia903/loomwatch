-- The team's name and each agent's name when a run started, so a client that has not read the team
-- file, such as the menu bar, can say who is working. NULL for runs recorded before this.
ALTER TABLE runs ADD COLUMN team_name TEXT;
-- JSON: `{agent id: name}`.
ALTER TABLE runs ADD COLUMN agent_names TEXT;
