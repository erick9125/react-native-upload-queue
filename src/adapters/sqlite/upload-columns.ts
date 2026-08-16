import type { UploadTask } from '../../core/models/upload-task.js';
import { serializeError, serializeMetadataValue } from './upload-row-mapper.js';

/**
 * The single source of truth for the shape of `upload_queue`.
 *
 * INSERT, UPDATE and their parameter lists are all derived from this array, so
 * they cannot drift apart. They used to be three hand-maintained lists whose
 * ordering had to match by inspection — adding a column meant editing each one
 * and nothing failed if you missed a spot.
 */
export const UPLOAD_COLUMNS = [
  'id',
  'file_uri',
  'file_name',
  'mime_type',
  'file_size',
  'destination',
  'method',
  'status',
  'attempts',
  'max_attempts',
  'idempotency_key',
  'progress',
  'bytes_uploaded',
  'total_bytes',
  'metadata',
  'last_error',
  'created_at',
  'updated_at',
  'next_attempt_at',
  'started_at',
  'completed_at',
  'processing_token',
  'processing_started_at',
  'remote_id',
] as const;

export type UploadColumn = (typeof UPLOAD_COLUMNS)[number];

const COLUMN_VALUES: Readonly<Record<UploadColumn, (task: UploadTask) => unknown>> = {
  id: (task) => task.id,
  file_uri: (task) => task.fileUri,
  file_name: (task) => task.fileName,
  mime_type: (task) => task.mimeType ?? null,
  file_size: (task) => task.size ?? null,
  destination: (task) => task.destination,
  method: (task) => task.method,
  status: (task) => task.status,
  attempts: (task) => task.attempts,
  max_attempts: (task) => task.maxAttempts,
  idempotency_key: (task) => task.idempotencyKey,
  progress: (task) => task.progress,
  bytes_uploaded: (task) => task.bytesUploaded ?? null,
  total_bytes: (task) => task.totalBytes ?? null,
  metadata: (task) => serializeMetadataValue(task.metadata),
  last_error: (task) => serializeError(task.lastError),
  created_at: (task) => task.createdAt,
  updated_at: (task) => task.updatedAt,
  next_attempt_at: (task) => task.nextAttemptAt ?? null,
  started_at: (task) => task.startedAt ?? null,
  completed_at: (task) => task.completedAt ?? null,
  processing_token: (task) => task.processingToken ?? null,
  processing_started_at: (task) => task.processingStartedAt ?? null,
  remote_id: (task) => task.remoteId ?? null,
};

const MUTABLE_COLUMNS = UPLOAD_COLUMNS.filter((column) => column !== 'id');

export const INSERT_SQL = `INSERT INTO upload_queue (${UPLOAD_COLUMNS.join(', ')})
VALUES (${UPLOAD_COLUMNS.map(() => '?').join(', ')})`;

export const UPDATE_SQL = `UPDATE upload_queue
SET ${MUTABLE_COLUMNS.map((column) => `${column} = ?`).join(', ')}
WHERE id = ?`;

/**
 * Same write, fenced on the claim token so a processor that lost ownership
 * cannot overwrite whoever holds it now. See `UploadStorage.updateOwned`.
 */
export const UPDATE_OWNED_SQL = `${UPDATE_SQL} AND processing_token = ?`;

export function insertParams(task: UploadTask): unknown[] {
  return UPLOAD_COLUMNS.map((column) => COLUMN_VALUES[column](task));
}

export function updateParams(task: UploadTask): unknown[] {
  return [...MUTABLE_COLUMNS.map((column) => COLUMN_VALUES[column](task)), task.id];
}
