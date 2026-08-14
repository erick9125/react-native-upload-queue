import { UploadQueueError } from './upload-queue.error.js';

export class FileNotFoundError extends UploadQueueError {
  constructor(_fileUri: string) {
    super({
      kind: 'file-not-found',
      message: 'Upload file no longer exists at the recorded URI',
      retryable: false,
    });
    this.name = 'FileNotFoundError';
  }
}
