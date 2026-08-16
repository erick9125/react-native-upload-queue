import { describe, expect, it } from 'vitest';
import { createSQLiteUploadStorage } from '../../src/adapters/sqlite/sqlite-upload-storage.js';
import {
  applyMigrations,
  MIGRATIONS,
  SCHEMA_VERSION,
  type Migration,
} from '../../src/adapters/sqlite/migrations.js';
import { UPLOAD_COLUMNS } from '../../src/adapters/sqlite/upload-columns.js';
import type { SQLiteDriver } from '../../src/adapters/sqlite/driver.js';
import type { UploadTask } from '../../src/core/models/upload-task.js';
import { createFakeSQLiteDriver } from '../helpers/fake-sqlite-driver.js';
import { createRealSQLiteDriver } from '../helpers/node-sqlite-driver.js';

const hasNodeSqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);

/** A task with every optional field populated, so nothing can be dropped silently. */
function fullyPopulatedTask(): UploadTask {
  return {
    id: 'complete-1',
    fileUri: 'file://invoice.pdf',
    fileName: 'invoice.pdf',
    mimeType: 'application/pdf',
    size: 2_048,
    destination: '/documents',
    method: 'PUT',
    status: 'pending',
    attempts: 2,
    maxAttempts: 7,
    idempotencyKey: 'idem-complete',
    progress: 0.42,
    bytesUploaded: 860,
    totalBytes: 2_048,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    nextAttemptAt: '2026-01-01T00:05:00.000Z',
    startedAt: '2026-01-01T00:00:30.000Z',
    completedAt: '2026-01-01T00:02:00.000Z',
    lastError: {
      kind: 'server',
      message: 'boom',
      retryable: true,
      occurredAt: '2026-01-01T00:00:50.000Z',
      statusCode: 503,
      retryAfterMs: 1_500,
    },
    metadata: { documentType: 'invoice', nested: { tag: 'q1' } },
    processingToken: 'token-complete',
    processingStartedAt: '2026-01-01T00:00:40.000Z',
    remoteId: 'remote-complete',
  };
}

describe('migration registry (M1)', () => {
  it('has strictly ascending, unique versions', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
    expect(new Set(versions).size).toBe(versions.length);
    expect(SCHEMA_VERSION).toBe(versions[versions.length - 1]);
  });

  it('applies pending migrations once and skips them on the next boot', async () => {
    const driver = createFakeSQLiteDriver();

    expect(await applyMigrations(driver)).toBe(MIGRATIONS.length);
    expect(await applyMigrations(driver)).toBe(0);
  });
});

describe.skipIf(!hasNodeSqlite)('migrations against a real engine (M1/M11)', () => {
  it('upgrades an existing database with a new column instead of silently skipping it', async () => {
    const handle = await createRealSQLiteDriver();
    if (!handle) {
      throw new Error('node:sqlite reported available but the driver could not be created');
    }

    // Boot at the shipped schema, as an app already in the field would be.
    await applyMigrations(handle.driver);
    await handle.driver.execute(
      `INSERT INTO upload_queue (id, file_uri, file_name, destination, method, status,
        attempts, max_attempts, idempotency_key, progress, created_at, updated_at)
       VALUES ('existing', 'file://a.jpg', 'a.jpg', '/uploads', 'POST', 'pending',
        0, 5, 'idem-existing', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );

    const next: Migration = {
      version: SCHEMA_VERSION + 1,
      statements: [`ALTER TABLE upload_queue ADD COLUMN checksum TEXT`],
    };

    const applied = await applyMigrations(handle.driver, [...MIGRATIONS, next]);
    expect(applied).toBe(1);

    // The column exists on the pre-existing row: this is exactly what
    // CREATE TABLE IF NOT EXISTS could never have done.
    const rows = await handle.driver.execute(`SELECT id, checksum FROM upload_queue`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.checksum).toBeNull();

    // And it is not replayed on the next boot.
    expect(await applyMigrations(handle.driver, [...MIGRATIONS, next])).toBe(0);

    await handle.driver.close?.();
  });

  it('persists and reads back through the real engine', async () => {
    const handle = await createRealSQLiteDriver();
    if (!handle) {
      throw new Error('node:sqlite reported available but the driver could not be created');
    }

    const storage = createSQLiteUploadStorage({ driver: handle.driver });
    await storage.initialize();
    await storage.insert(fullyPopulatedTask());

    const loaded = await storage.get('complete-1');
    expect(loaded?.fileName).toBe('invoice.pdf');
    await storage.close?.();
  });
});

describe('persistence round trip (M5)', () => {
  const suites: Array<{ name: string; create: () => Promise<SQLiteDriver> }> = [
    { name: 'fake driver', create: async () => createFakeSQLiteDriver() },
    ...(hasNodeSqlite
      ? [
          {
            name: 'node:sqlite',
            create: async (): Promise<SQLiteDriver> => {
              const handle = await createRealSQLiteDriver();
              if (!handle) {
                throw new Error('node:sqlite driver could not be created');
              }
              return handle.driver;
            },
          },
        ]
      : []),
  ];

  it('has a unique column list with id first', () => {
    expect(new Set(UPLOAD_COLUMNS).size).toBe(UPLOAD_COLUMNS.length);
    expect(UPLOAD_COLUMNS[0]).toBe('id');
  });

  it.each(suites)(
    'round-trips every field of a fully populated task through the $name',
    async ({ create }) => {
      const storage = createSQLiteUploadStorage({ driver: await create() });
      await storage.initialize();

      const task = fullyPopulatedTask();
      await storage.insert(task);
      // A field added to UploadTask but forgotten in the column table fails here
      // instead of vanishing silently on the way to disk.
      expect(await storage.get(task.id)).toEqual(task);

      // And again through UPDATE, which uses a different parameter ordering.
      const moved: UploadTask = { ...task, progress: 0.9, remoteId: 'remote-updated' };
      await storage.update(moved);
      expect(await storage.get(task.id)).toEqual(moved);

      await storage.close?.();
    },
  );
});
