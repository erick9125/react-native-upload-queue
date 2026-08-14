import type { UploadError } from './upload-error.js';
import type { UploadStatus } from './upload-status.js';

export interface UploadQueuedEvent {
  readonly type: 'upload.queued';
  readonly uploadId: string;
  readonly status: UploadStatus;
}

export interface UploadStartedEvent {
  readonly type: 'upload.started';
  readonly uploadId: string;
  readonly attempts: number;
}

export interface UploadProgressEvent {
  readonly type: 'upload.progress';
  readonly uploadId: string;
  readonly progress: number;
  readonly bytesUploaded: number;
  readonly totalBytes?: number;
}

export interface UploadCompletedEvent {
  readonly type: 'upload.completed';
  readonly uploadId: string;
  readonly remoteId?: string;
  readonly attempts: number;
}

export interface UploadRetryScheduledEvent {
  readonly type: 'upload.retry_scheduled';
  readonly uploadId: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly delayMs: number;
  readonly error: UploadError;
}

export interface UploadFailedEvent {
  readonly type: 'upload.failed';
  readonly uploadId: string;
  readonly error: UploadError;
  readonly attempts: number;
}

export interface UploadPausedEvent {
  readonly type: 'upload.paused';
  readonly uploadId: string;
}

export interface UploadCancelledEvent {
  readonly type: 'upload.cancelled';
  readonly uploadId: string;
}

export interface UploadBlockedEvent {
  readonly type: 'upload.blocked';
  readonly uploadId: string;
  readonly error: UploadError;
  readonly attempts: number;
}

export type UploadQueueEvent =
  | UploadQueuedEvent
  | UploadStartedEvent
  | UploadProgressEvent
  | UploadCompletedEvent
  | UploadRetryScheduledEvent
  | UploadFailedEvent
  | UploadPausedEvent
  | UploadCancelledEvent
  | UploadBlockedEvent;
