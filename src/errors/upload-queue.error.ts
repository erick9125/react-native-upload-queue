import type { UploadError, UploadErrorKind } from '../core/models/upload-error.js';

export class UploadQueueError extends Error {
  readonly kind: UploadErrorKind;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: {
    kind: UploadErrorKind;
    message: string;
    retryable: boolean;
    statusCode?: number;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = 'UploadQueueError';
    this.kind = input.kind;
    this.retryable = input.retryable;
    if (input.statusCode !== undefined) {
      this.statusCode = input.statusCode;
    }
    if (input.retryAfterMs !== undefined) {
      this.retryAfterMs = input.retryAfterMs;
    }
  }

  toUploadError(occurredAt: string): UploadError {
    return {
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      occurredAt,
      ...(this.statusCode !== undefined ? { statusCode: this.statusCode } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

export function createUploadError(input: {
  kind: UploadErrorKind;
  message: string;
  retryable: boolean;
  occurredAt: string;
  statusCode?: number;
  retryAfterMs?: number;
}): UploadError {
  return {
    kind: input.kind,
    message: input.message,
    retryable: input.retryable,
    occurredAt: input.occurredAt,
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  };
}
