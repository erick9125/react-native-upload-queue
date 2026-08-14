export const SCHEMA_VERSION = 1;

export const CREATE_META_TABLE = `
CREATE TABLE IF NOT EXISTS upload_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

export const CREATE_UPLOAD_QUEUE_TABLE = `
CREATE TABLE IF NOT EXISTS upload_queue (
  id TEXT PRIMARY KEY,
  file_uri TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER,
  destination TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  idempotency_key TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER,
  total_bytes INTEGER,
  metadata TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_attempt_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  processing_token TEXT,
  processing_started_at TEXT,
  remote_id TEXT
);
`;

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_upload_queue_pending
   ON upload_queue (status, next_attempt_at, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_upload_queue_processing
   ON upload_queue (status, processing_started_at);`,
] as const;
