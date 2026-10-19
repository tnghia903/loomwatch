-- How the operator reacted to something an agent said in a team's chat: one face per thing said,
-- the way a tapback works. `anchor` is the run it was said in, so a page of the chat reads its
-- reactions by the pieces of work it shows; `target` is what in that run (the answer, or a line
-- of the agents' talk). Each face tells the team something, said in the next work's conversation
-- (crates/loomwatch-backend/src/chat.rs), so a line of talk keeps who said it, what it was and
-- how it began. The agents' own reactions are not stored: the chat reads them from the record.
CREATE TABLE chat_reactions (
    team_key   TEXT NOT NULL,
    anchor     TEXT NOT NULL,
    target     TEXT NOT NULL,
    face       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    agent_id   TEXT,
    what       TEXT,
    quote      TEXT,
    PRIMARY KEY (anchor, target)
);
