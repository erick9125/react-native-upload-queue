import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  toUploadError,
} from '../../src/core/processor/upload-error-classifier.js';
import { FileNotFoundError } from '../../src/errors/file-not-found.error.js';

const occurredAt = '2026-08-13T15:00:00.000Z';

describe('classifyHttpStatus', () => {
  it('classifies network-like timeouts as retryable', () => {
    const error = classifyHttpStatus(408, occurredAt);
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });

  it('classifies 401 as authentication and not retryable', () => {
    const error = classifyHttpStatus(401, occurredAt);
    expect(error.kind).toBe('authentication');
    expect(error.retryable).toBe(false);
  });

  it('classifies 403 as authorization and not retryable', () => {
    const error = classifyHttpStatus(403, occurredAt);
    expect(error.kind).toBe('authorization');
    expect(error.retryable).toBe(false);
  });

  it('classifies 429 as rate-limit and preserves Retry-After', () => {
    const error = classifyHttpStatus(429, occurredAt, 30_000);
    expect(error.kind).toBe('rate-limit');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(30_000);
  });

  it('classifies 500-class responses as retryable server errors', () => {
    for (const status of [500, 502, 503, 504]) {
      const error = classifyHttpStatus(status, occurredAt);
      expect(error.kind).toBe('server');
      expect(error.retryable).toBe(true);
    }
  });

  it('classifies 400 as a non-retryable validation error', () => {
    const error = classifyHttpStatus(400, occurredAt);
    expect(error.kind).toBe('validation');
    expect(error.retryable).toBe(false);
  });
});

describe('toUploadError', () => {
  it('maps TypeError to a retryable network error', () => {
    const error = toUploadError(new TypeError('Network request failed'), occurredAt);
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });

  it('maps file-not-found errors without making them retryable', () => {
    const error = toUploadError(new FileNotFoundError('file://gone.jpg'), occurredAt);
    expect(error.kind).toBe('file-not-found');
    expect(error.retryable).toBe(false);
  });

  it('maps AbortError to cancelled', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const error = toUploadError(abort, occurredAt);
    expect(error.kind).toBe('cancelled');
    expect(error.retryable).toBe(false);
  });
});
