import type { UploadError } from './upload-error.js';
import type { UploadStatus } from './upload-status.js';

export type UploadHttpMethod = 'POST' | 'PUT';

export interface UploadTask {
  readonly id: string;
  readonly fileUri: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly destination: string;
  readonly method: UploadHttpMethod;
  readonly status: UploadStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string;
  readonly progress: number;
  readonly bytesUploaded?: number;
  readonly totalBytes?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAttemptAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly lastError?: UploadError;
  readonly metadata?: Record<string, unknown>;
  readonly processingToken?: string;
  readonly processingStartedAt?: string;
  readonly remoteId?: string;
}

export interface EnqueueUploadInput {
  readonly fileUri: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly destination: string;
  readonly method?: UploadHttpMethod;
  readonly maxAttempts?: number;
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, unknown>;
}
