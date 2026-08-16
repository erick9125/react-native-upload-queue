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

export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

/**
 * Ordered, append-only. Each entry runs exactly once per database and the
 * recorded version advances after it, so an upgrade applies only what the
 * device is missing.
 *
 * Adding a column means appending a new entry with its `ALTER TABLE` — never
 * editing an existing one and never relying on `CREATE TABLE IF NOT EXISTS`,
 * which silently does nothing when the table already exists.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [CREATE_UPLOAD_QUEUE_TABLE, ...CREATE_INDEXES],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

const READ_SCHEMA_VERSION_SQL = `SELECT value FROM upload_meta WHERE key = ? LIMIT 1`;

const WRITE_SCHEMA_VERSION_SQL = `INSERT INTO upload_meta (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/**
 * Applies every migration the database has not seen yet, recording the version
 * after each one so an interrupted upgrade resumes where it stopped rather than
 * replaying from scratch.
 *
 * `migrations` is a parameter so the upgrade path itself is testable against a
 * real engine, not just the initial create.
 */
export async function applyMigrations(
  driver: { execute(sql: string, params?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[] }> },
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number> {
  await driver.execute(CREATE_META_TABLE);

  const versionResult = await driver.execute(READ_SCHEMA_VERSION_SQL, ['schema_version']);
  const currentVersion = Number(versionResult.rows[0]?.value ?? 0);

  let applied = 0;
  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (migration.version <= currentVersion) {
      continue;
    }

    for (const statement of migration.statements) {
      await driver.execute(statement);
    }

    await driver.execute(WRITE_SCHEMA_VERSION_SQL, ['schema_version', String(migration.version)]);
    applied += 1;
  }

  return applied;
}
