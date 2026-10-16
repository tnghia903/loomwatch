-- The team file a run executed, as the `sha256:` digest of its bytes: the revision `GET /api/team`
-- and approvals (ADR 0048) already name. Fixed when the run is prepared, so a run can be compared
-- with the team file as it is now. Quests (docs/QUESTS.md) judge a run only while its team file
-- is still this revision, so a setting added later never counts for a run that never had it.
-- NULL for runs recorded before this column: unknown, never a match.
ALTER TABLE runs ADD COLUMN team_revision TEXT;
