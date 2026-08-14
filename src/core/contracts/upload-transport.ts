import type { UploadTask } from '../models/upload-task.js';

export interface UploadTransportContext {
  readonly signal: AbortSignal;
  readonly onProgress: (bytesUploaded: number, totalBytes?: number) => void;
}

export interface UploadTransportResult {
  readonly statusCode: number;
  readonly remoteId?: string;
  readonly response?: unknown;
  readonly retryAfterMs?: number;
}

export interface UploadTransport {
  upload(task: UploadTask, context: UploadTransportContext): Promise<UploadTransportResult>;
}
