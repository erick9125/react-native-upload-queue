import { UploadQueueError } from './upload-queue.error.js';

export class FileNotFoundError extends UploadQueueError {
  readonly fileUri: string;

  constructor(fileUri: string) {
    super({
      kind: 'file-not-found',
      message: `Upload file no longer exists at the recorded URI: ${fileUri}`,
      retryable: false,
    });
    this.name = 'FileNotFoundError';
    this.fileUri = fileUri;
  }
}
