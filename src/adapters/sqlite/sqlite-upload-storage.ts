import type { UploadStorage } from '../../core/contracts/upload-storage.js';
import type { UploadTask } from '../../core/models/upload-task.js';
import { UploadNotFoundError } from '../../errors/upload-not-found.error.js';
import { UploadQueueError } from '../../errors/upload-queue.error.js';
import type { SQLiteDriver, SQLiteUploadStorageOptions } from './driver.js';
import { CREATE_INDEXES, CREATE_META_TABLE, CREATE_UPLOAD_QUEUE_TABLE, SCHEMA_VERSION } from './migrations.js';
import { mapUploadRow, serializeError, serializeMetadataValue } from './upload-row-mapper.js';

async function ensureSchema(driver: SQLiteDriver): Promise<void> {
  await driver.execute(CREATE_META_TABLE);
  await driver.execute(CREATE_UPLOAD_QUEUE_TABLE);
  for (const statement of CREATE_INDEXES) {
    await driver.execute(statement);
  }

  const versionResult = await driver.execute(`SELECT value FROM upload_meta WHERE key = ? LIMIT 1`, [
    'schema_version',
  ]);
  const currentVersion = Number(versionResult.rows[0]?.value ?? 0);

  if (currentVersion < SCHEMA_VERSION) {
    await driver.execute(
      `INSERT INTO upload_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ['schema_version', String(SCHEMA_VERSION)],
    );
  }
}

const UPDATE_SQL = `UPDATE upload_queue
SET file_uri = ?, file_name = ?, mime_type = ?, file_size = ?, destination = ?, method = ?,
    status = ?, attempts = ?, max_attempts = ?, idempotency_key = ?, progress = ?,
    bytes_uploaded = ?, total_bytes = ?, metadata = ?, last_error = ?, created_at = ?,
    updated_at = ?, next_attempt_at = ?, started_at = ?, completed_at = ?,
    processing_token = ?, processing_started_at = ?, remote_id = ?
WHERE id = ?`;

function updateParams(task: UploadTask): unknown[] {
  return [
    task.fileUri,
    task.fileName,
    task.mimeType ?? null,
    task.size ?? null,
    task.destination,
    task.method,
    task.status,
    task.attempts,
    task.maxAttempts,
    task.idempotencyKey,
    task.progress,
    task.bytesUploaded ?? null,
    task.totalBytes ?? null,
    serializeMetadataValue(task.metadata),
    serializeError(task.lastError),
    task.createdAt,
    task.updatedAt,
    task.nextAttemptAt ?? null,
    task.startedAt ?? null,
    task.completedAt ?? null,
    task.processingToken ?? null,
    task.processingStartedAt ?? null,
    task.remoteId ?? null,
    task.id,
  ];
}

export function createSQLiteUploadStorage(options: SQLiteUploadStorageOptions): UploadStorage {
  let driverPromise: Promise<SQLiteDriver> | undefined;
  let schemaPromise: Promise<void> | undefined;

  const resolveDriver = async (): Promise<SQLiteDriver> => {
    if (options.driver) {
      return options.driver;
    }

    if (!options.openDriver) {
      throw new Error(
        'createSQLiteUploadStorage requires either `driver` or `openDriver`. Pass your React Native SQLite driver factory.',
      );
    }

    if (!driverPromise) {
      const databaseName = options.databaseName ?? 'uploads.db';
      driverPromise = Promise.resolve(options.openDriver(databaseName));
    }

    return driverPromise;
  };

  const ensureReady = async (): Promise<SQLiteDriver> => {
    const driver = await resolveDriver();
    schemaPromise ??= ensureSchema(driver).catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });
    await schemaPromise;
    return driver;
  };

  const adapter: UploadStorage = {
    async initialize(): Promise<void> {
      await ensureReady();
    },

    async insert(task: UploadTask): Promise<void> {
      const driver = await ensureReady();
      try {
        await driver.execute(
          `INSERT INTO upload_queue (
            id, file_uri, file_name, mime_type, file_size, destination, method, status,
            attempts, max_attempts, idempotency_key, progress, bytes_uploaded, total_bytes,
            metadata, last_error, created_at, updated_at, next_attempt_at, started_at,
            completed_at, processing_token, processing_started_at, remote_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            task.id,
            task.fileUri,
            task.fileName,
            task.mimeType ?? null,
            task.size ?? null,
            task.destination,
            task.method,
            task.status,
            task.attempts,
            task.maxAttempts,
            task.idempotencyKey,
            task.progress,
            task.bytesUploaded ?? null,
            task.totalBytes ?? null,
            serializeMetadataValue(task.metadata),
            serializeError(task.lastError),
            task.createdAt,
            task.updatedAt,
            task.nextAttemptAt ?? null,
            task.startedAt ?? null,
            task.completedAt ?? null,
            task.processingToken ?? null,
            task.processingStartedAt ?? null,
            task.remoteId ?? null,
          ],
        );
      } catch (error) {
        const existing = await adapter.get(task.id);
        if (existing) {
          throw new UploadQueueError({
            kind: 'validation',
            message: `Upload ${task.id} is already queued`,
            retryable: false,
          });
        }
        throw error;
      }
    },

    async update(task: UploadTask): Promise<void> {
      const driver = await ensureReady();
      const result = await driver.execute(UPDATE_SQL, updateParams(task));
      if (result.rowsAffected === 0) {
        throw new UploadNotFoundError(task.id);
      }
    },

    async get(id: string): Promise<UploadTask | null> {
      const driver = await ensureReady();
      const result = await driver.execute(`SELECT * FROM upload_queue WHERE id = ? LIMIT 1`, [id]);
      const row = result.rows[0];
      return row ? mapUploadRow(row) : null;
    },

    async getPending(limit: number, nowIso: string): Promise<readonly UploadTask[]> {
      const driver = await ensureReady();
      const result = await driver.execute(
        `SELECT * FROM upload_queue
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC
         LIMIT ?`,
        [nowIso, limit],
      );
      return result.rows.map((row) => mapUploadRow(row));
    },

    async getRecoverable(staleBeforeIso: string): Promise<readonly UploadTask[]> {
      const driver = await ensureReady();
      const result = await driver.execute(
        `SELECT * FROM upload_queue
         WHERE status = 'uploading'
           AND processing_started_at IS NOT NULL
           AND processing_started_at <= ?
         ORDER BY processing_started_at ASC`,
        [staleBeforeIso],
      );
      return result.rows.map((row) => mapUploadRow(row));
    },

    async claim(
      id: string,
      processingToken: string,
      nowIso: string,
    ): Promise<UploadTask | null> {
      const driver = await ensureReady();

      return driver.transaction(async (tx) => {
        const current = await tx.execute(`SELECT * FROM upload_queue WHERE id = ? LIMIT 1`, [id]);
        const row = current.rows[0];
        if (!row || String(row.status) !== 'pending') {
          return null;
        }

        if (row.next_attempt_at != null && String(row.next_attempt_at) > nowIso) {
          return null;
        }

        const result = await tx.execute(
          `UPDATE upload_queue
           SET status = 'uploading',
               processing_token = ?,
               processing_started_at = ?,
               started_at = COALESCE(started_at, ?),
               updated_at = ?,
               next_attempt_at = NULL,
               progress = 0,
               bytes_uploaded = 0
           WHERE id = ? AND status = 'pending'`,
          [processingToken, nowIso, nowIso, nowIso, id],
        );

        if (result.rowsAffected === 0) {
          return null;
        }

        const claimed = await tx.execute(`SELECT * FROM upload_queue WHERE id = ? LIMIT 1`, [id]);
        const claimedRow = claimed.rows[0];
        return claimedRow ? mapUploadRow(claimedRow) : null;
      });
    },

    async delete(id: string): Promise<void> {
      const driver = await ensureReady();
      await driver.execute(`DELETE FROM upload_queue WHERE id = ?`, [id]);
    },

    async list(): Promise<readonly UploadTask[]> {
      const driver = await ensureReady();
      const result = await driver.execute(
        `SELECT * FROM upload_queue ORDER BY created_at ASC`,
      );
      return result.rows.map((row) => mapUploadRow(row));
    },

    async deleteCompleted(olderThanIso?: string): Promise<number> {
      const driver = await ensureReady();
      if (olderThanIso) {
        const result = await driver.execute(
          `DELETE FROM upload_queue WHERE status = 'completed' AND updated_at <= ?`,
          [olderThanIso],
        );
        return result.rowsAffected ?? 0;
      }

      const result = await driver.execute(`DELETE FROM upload_queue WHERE status = 'completed'`);
      return result.rowsAffected ?? 0;
    },

    async close(): Promise<void> {
      const pending = driverPromise;
      schemaPromise = undefined;
      driverPromise = undefined;

      if (options.driver) {
        await options.driver.close?.();
        return;
      }

      if (pending) {
        const driver = await pending;
        await driver.close?.();
      }
    },
  };

  return adapter;
}

export type { SQLiteDriver, SQLiteQueryResult, SQLiteUploadStorageOptions } from './driver.js';
