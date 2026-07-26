CREATE TABLE IF NOT EXISTS send_attempts (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  success INTEGER NOT NULL,
  http_status INTEGER,
  request_id TEXT,
  provider_response TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_send_attempts_created ON send_attempts(created_at DESC);
