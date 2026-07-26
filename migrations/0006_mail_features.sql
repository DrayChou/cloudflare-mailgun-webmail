ALTER TABLE messages ADD COLUMN cc TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN bcc TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN in_reply_to TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN references_header TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);
