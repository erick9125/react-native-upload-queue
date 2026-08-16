import type { UploadError } from '../models/upload-error.js';
import { classifyHttpStatus, toUploadError } from '../../errors/classify.js';

/**
 * Injectable seam over the classification rules, so a host can swap in its own
 * policy (a 409 that means "already stored", say) without forking the processor.
 */
export class UploadErrorClassifier {
  classifyHttp(statusCode: number, occurredAt: string, retryAfterMs?: number): UploadError {
    return classifyHttpStatus(statusCode, occurredAt, retryAfterMs);
  }

  classifyUnknown(error: unknown, occurredAt: string): UploadError {
    return toUploadError(error, occurredAt);
  }
}

export { classifyHttpStatus, toUploadError };
