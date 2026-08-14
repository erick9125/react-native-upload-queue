import type { UploadStatus } from '../core/models/upload-status.js';
import { UploadQueueError } from './upload-queue.error.js';

export class InvalidUploadStateError extends UploadQueueError {
  constructor(uploadId: string, from: UploadStatus, to: UploadStatus) {
    super({
      kind: 'validation',
      message: `Upload ${uploadId} cannot transition from ${from} to ${to}`,
      retryable: false,
    });
    this.name = 'InvalidUploadStateError';
  }
}
