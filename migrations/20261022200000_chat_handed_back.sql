-- A team's work handed back to the agent that asked for it (ADR 0083, decision 10): which team, its
-- answering agent, what it was asked and the words before its answer, so the chat shows the message
-- as the team's rather than the operator's. JSON; NULL for every other message.
ALTER TABLE chat_messages ADD COLUMN handed_back TEXT;
