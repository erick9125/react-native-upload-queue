import type { UploadError } from '../core/models/upload-error.js';
import { isAbortError, isTimeoutError } from '../core/utils.js';
import { createUploadError, UploadQueueError } from './upload-queue.error.js';

export function classifyHttpStatus(
  statusCode: number,
  occurredAt: string,
  retryAfterMs?: number,
): UploadError {
  if (statusCode === 401) {
    return createUploadError({
      kind: 'authentication',
      message: 'Authentication failed with status 401',
      statusCode,
      retryable: false,
      occurredAt,
    });
  }

  if (statusCode === 403) {
    return createUploadError({
      kind: 'authorization',
      message: 'Authorization failed with status 403',
      statusCode,
      retryable: false,
      occurredAt,
    });
  }

  if (statusCode === 408) {
    return createUploadError({
      kind: 'network',
      message: 'Upload timed out with status 408',
      statusCode,
      retryable: true,
      occurredAt,
    });
  }

  if (statusCode === 429) {
    return createUploadError({
      kind: 'rate-limit',
      message: 'Upload was rate limited with status 429',
      statusCode,
      retryable: true,
      occurredAt,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  if (statusCode >= 500) {
    return createUploadError({
      kind: 'server',
      message: `Server error with status ${statusCode}`,
      statusCode,
      retryable: true,
      occurredAt,
    });
  }

  if (statusCode >= 400) {
    return createUploadError({
      kind: 'validation',
      message: `Upload was rejected with status ${statusCode}`,
      statusCode,
      retryable: false,
      occurredAt,
    });
  }

  return createUploadError({
    kind: 'unknown',
    message: `Unexpected HTTP status ${statusCode}`,
    statusCode,
    retryable: false,
    occurredAt,
  });
}

const NETWORK_HINTS = [
  'network',
  'fetch',
  'timeout',
  'econnrefused',
  'enotfound',
  'offline',
  'failed to fetch',
] as const;

export function toUploadError(error: unknown, occurredAt: string): UploadError {
  if (error instanceof UploadQueueError) {
    return error.toUploadError(occurredAt);
  }

  if (typeof error === 'object' && error !== null && 'kind' in error && 'retryable' in error) {
    const candidate = error as UploadError;
    return {
      kind: candidate.kind,
      message: candidate.message,
      retryable: candidate.retryable,
      occurredAt: candidate.occurredAt ?? occurredAt,
      ...(candidate.statusCode !== undefined ? { statusCode: candidate.statusCode } : {}),
      ...(candidate.retryAfterMs !== undefined ? { retryAfterMs: candidate.retryAfterMs } : {}),
    };
  }

  // Checked before the abort branch: a deadline is a retryable network problem,
  // not the user cancelling. `AbortSignal.timeout` aborts with `TimeoutError`,
  // which used to fall through and only be classified correctly because the
  // runtime happened to put the word "timeout" in the message.
  if (isTimeoutError(error)) {
    return createUploadError({
      kind: 'network',
      message: error instanceof Error ? error.message : 'Upload timed out',
      retryable: true,
      occurredAt,
    });
  }

  if (isAbortError(error)) {
    return createUploadError({
      kind: 'cancelled',
      message: 'Upload request was aborted',
      retryable: false,
      occurredAt,
    });
  }

  if (error instanceof TypeError) {
    return createUploadError({
      kind: 'network',
      message: error.message || 'Network request failed',
      retryable: true,
      occurredAt,
    });
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Last resort for runtimes that surface network faults as plain Errors with
    // no distinguishing name. Everything above classifies by type.
    if (NETWORK_HINTS.some((hint) => message.includes(hint))) {
      return createUploadError({
        kind: 'network',
        message: error.message,
        retryable: true,
        occurredAt,
      });
    }

    return createUploadError({
      kind: 'unknown',
      message: error.message,
      retryable: false,
      occurredAt,
    });
  }

  return createUploadError({
    kind: 'unknown',
    message: 'Unknown upload error',
    retryable: false,
    occurredAt,
  });
}
