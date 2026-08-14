import { UploadQueueError } from './upload-queue.error.js';

export class UploadNotFoundError extends UploadQueueError {
  constructor(uploadId: string) {
    super({
      kind: 'validation',
      message: `Upload ${uploadId} was not found`,
      retryable: false,
    });
    this.name = 'UploadNotFoundError';
  }
}
