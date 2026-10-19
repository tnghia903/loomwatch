-- The agents' own answers to an @ message that needed no workflow ("hi @team"): the message stays a
-- team note, nothing runs, and the agents it was for answer it themselves, at the same time. JSON
-- {waiting: [agent ids], said: [{from, text, at}]}; NULL for every other message, and for every
-- message sent before these answers.
ALTER TABLE chat_messages ADD COLUMN answers TEXT;
