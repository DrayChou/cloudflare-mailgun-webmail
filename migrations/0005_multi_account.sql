ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE messages ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_messages_owner_direction_created
  ON messages(owner_user_id, direction, created_at DESC);
