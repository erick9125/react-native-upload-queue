import type { UploadError } from '../../core/models/upload-error.js';
import type { UploadHttpMethod, UploadTask } from '../../core/models/upload-task.js';
import type { UploadStatus } from '../../core/models/upload-status.js';
import { cloneJson } from '../../core/utils.js';

export interface UploadQueueRow {
  readonly id: string;
  readonly file_uri: string;
  readonly file_name: string;
  readonly mime_type: string | null;
  readonly file_size: number | null;
  readonly destination: string;
  readonly method: string;
  readonly status: string;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly idempotency_key: string;
  readonly progress: number;
  readonly bytes_uploaded: number | null;
  readonly total_bytes: number | null;
  readonly metadata: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_attempt_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly processing_token: string | null;
  readonly processing_started_at: string | null;
  readonly remote_id: string | null;
}

function deserializeError(raw: string | null | undefined): UploadError | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as UploadError;
  } catch {
    return {
      kind: 'unknown',
      message: 'Persisted error payload was invalid',
      retryable: false,
      occurredAt: new Date(0).toISOString(),
    };
  }
}

function deserializeMetadata(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function mapUploadRow(row: Record<string, unknown>): UploadTask {
  const lastError = deserializeError(row.last_error == null ? null : String(row.last_error));
  const metadata = deserializeMetadata(row.metadata == null ? null : String(row.metadata));

  return {
    id: String(row.id),
    fileUri: String(row.file_uri),
    fileName: String(row.file_name),
    destination: String(row.destination),
    method: String(row.method) as UploadHttpMethod,
    status: String(row.status) as UploadStatus,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    idempotencyKey: String(row.idempotency_key),
    progress: Number(row.progress ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.mime_type != null ? { mimeType: String(row.mime_type) } : {}),
    ...(row.file_size != null ? { size: Number(row.file_size) } : {}),
    ...(row.bytes_uploaded != null ? { bytesUploaded: Number(row.bytes_uploaded) } : {}),
    ...(row.total_bytes != null ? { totalBytes: Number(row.total_bytes) } : {}),
    ...(metadata !== undefined ? { metadata: cloneJson(metadata) } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    ...(row.next_attempt_at != null ? { nextAttemptAt: String(row.next_attempt_at) } : {}),
    ...(row.started_at != null ? { startedAt: String(row.started_at) } : {}),
    ...(row.completed_at != null ? { completedAt: String(row.completed_at) } : {}),
    ...(row.processing_token != null ? { processingToken: String(row.processing_token) } : {}),
    ...(row.processing_started_at != null
      ? { processingStartedAt: String(row.processing_started_at) }
      : {}),
    ...(row.remote_id != null ? { remoteId: String(row.remote_id) } : {}),
  };
}

export function serializeError(error: UploadError | undefined): string | null {
  return error ? JSON.stringify(error) : null;
}

export function serializeMetadataValue(metadata: Record<string, unknown> | undefined): string | null {
  return metadata ? JSON.stringify(metadata) : null;
}
