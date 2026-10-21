-- Files sent with a chat message (ADR 0082): each one's name, full path, size and whether it is a
-- picture, as the chat shows them. JSON; NULL for a message with no files, and for every message
-- sent before files.
ALTER TABLE chat_messages ADD COLUMN files TEXT;
