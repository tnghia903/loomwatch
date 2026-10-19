-- A chat message written as a reply (ADR 0051): the message it answers, as the operator saw it —
-- who wrote it, to whom, what kind of message it was and its words. JSON; NULL for a message that
-- replies to nothing, and for every message sent before replies.
ALTER TABLE chat_messages ADD COLUMN reply_to TEXT;
