import type { UploadStorage } from '../../core/contracts/upload-storage.js';
import type { UploadTask } from '../../core/models/upload-task.js';
import { UploadNotFoundError } from '../../errors/upload-not-found.error.js';
import { UploadQueueError } from '../../errors/upload-queue.error.js';
import type { SQLiteDriver, SQLiteUploadStorageOptions } from './driver.js';
import { applyMigrations } from './migrations.js';
import { mapUploadRow } from './upload-row-mapper.js';
import {
  INSERT_SQL,
  insertParams,
  UPDATE_OWNED_SQL,
  UPDATE_SQL,
  updateParams,
} from './upload-columns.js';

/**
 * Progress is the hottest write in the library — a few times per second per
 * upload. It touches four columns and never re-serializes metadata or the last
 * error, unlike the full-row UPDATE above.
 */
const UPDATE_PROGRESS_SQL = `UPDATE upload_queue
SET progress = ?, bytes_uploaded = ?, total_bytes = COALESCE(?, total_bytes), updated_at = ?
WHERE id = ? AND processing_token = ? AND status = 'uploading'`;

/** Recovery is a diagnostic read; cap it so a corrupt queue cannot exhaust memory. */
const DEFAULT_RECOVERABLE_LIMIT = 500;

/** Wording differs across SQLite bindings, so match on the shared vocabulary. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('unique') || message.includes('primary key');
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
    schemaPromise ??= applyMigrations(driver).then(() => undefined).catch((error: unknown) => {
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
        await driver.execute(INSERT_SQL, insertParams(task));
      } catch (error) {
        // Only a constraint violation is treated as a duplicate. Probing with a
        // SELECT after *any* driver error used to report disk and IO faults as
        // "already queued", hiding the real problem.
        if (!isUniqueViolation(error)) {
          throw error;
        }

        throw new UploadQueueError({
          kind: 'validation',
          message: `Upload ${task.id} is already queued`,
          retryable: false,
          cause: error,
        });
      }
    },

    async update(task: UploadTask): Promise<void> {
      const driver = await ensureReady();
      const result = await driver.execute(UPDATE_SQL, updateParams(task));
      if (result.rowsAffected === 0) {
        throw new UploadNotFoundError(task.id);
      }
    },

    async updateOwned(task: UploadTask, processingToken: string): Promise<boolean> {
      const driver = await ensureReady();
      const result = await driver.execute(UPDATE_OWNED_SQL, [
        ...updateParams(task),
        processingToken,
      ]);
      return (result.rowsAffected ?? 0) > 0;
    },

    async updateProgress(update): Promise<boolean> {
      const driver = await ensureReady();
      const result = await driver.execute(UPDATE_PROGRESS_SQL, [
        update.progress,
        update.bytesUploaded,
        update.totalBytes ?? null,
        update.updatedAt,
        update.id,
        update.processingToken,
      ]);
      return (result.rowsAffected ?? 0) > 0;
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

    async getRecoverable(
      staleBeforeIso: string,
      limit = DEFAULT_RECOVERABLE_LIMIT,
    ): Promise<readonly UploadTask[]> {
      const driver = await ensureReady();
      const result = await driver.execute(
        `SELECT * FROM upload_queue
         WHERE status = 'uploading'
           AND processing_started_at IS NOT NULL
           AND processing_started_at <= ?
         ORDER BY processing_started_at ASC
         LIMIT ?`,
        [staleBeforeIso, limit],
      );
      return result.rows.map((row) => mapUploadRow(row));
    },

    async recoverAbandoned(staleBeforeIso: string, updatedAt: string): Promise<number> {
      const driver = await ensureReady();
      const result = await driver.execute(
        `UPDATE upload_queue
         SET status = 'pending',
             updated_at = ?,
             progress = 0,
             processing_token = NULL,
             processing_started_at = NULL,
             next_attempt_at = NULL
         WHERE status = 'uploading'
           AND processing_started_at IS NOT NULL
           AND processing_started_at <= ?`,
        [updatedAt, staleBeforeIso],
      );
      return result.rowsAffected ?? 0;
    },

    async getEarliestNextAttemptAt(): Promise<string | null> {
      const driver = await ensureReady();
      const result = await driver.execute(
        `SELECT MIN(next_attempt_at) AS earliest FROM upload_queue
         WHERE status = 'pending' AND next_attempt_at IS NOT NULL`,
      );
      const earliest = result.rows[0]?.earliest;
      return earliest == null ? null : String(earliest);
    },

    /**
     * Compare-and-set claim. A single conditional UPDATE is already atomic in
     * SQLite, so this deliberately avoids an explicit transaction: claims run
     * concurrently whenever `concurrency > 1`, and drivers that map
     * `transaction()` onto plain BEGIN/COMMIT on one connection reject the
     * overlap with "cannot start a transaction within a transaction".
     */
    async claim(
      id: string,
      processingToken: string,
      nowIso: string,
    ): Promise<UploadTask | null> {
      const driver = await ensureReady();

      const result = await driver.execute(
        `UPDATE upload_queue
         SET status = 'uploading',
             processing_token = ?,
             processing_started_at = ?,
             started_at = COALESCE(started_at, ?),
             updated_at = ?,
             next_attempt_at = NULL,
             progress = 0,
             bytes_uploaded = 0
         WHERE id = ?
           AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
        [processingToken, nowIso, nowIso, nowIso, id, nowIso],
      );

      if ((result.rowsAffected ?? 0) === 0) {
        return null;
      }

      // Read back through the token so the row we return is provably ours.
      const claimed = await driver.execute(
        `SELECT * FROM upload_queue WHERE id = ? AND processing_token = ? LIMIT 1`,
        [id, processingToken],
      );
      const claimedRow = claimed.rows[0];
      return claimedRow ? mapUploadRow(claimedRow) : null;
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
        // Ages by when the upload finished, not when the row was last touched:
        // any later write used to bump updated_at and rescue the row from purging.
        const result = await driver.execute(
          `DELETE FROM upload_queue
           WHERE status = 'completed' AND COALESCE(completed_at, updated_at) <= ?`,
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
