import { describe, expect, it } from 'vitest';
import { classifyHttpStatus, toUploadError } from '../../src/core/processor/upload-error-classifier.js';
import { createExponentialBackoff } from '../../src/core/retry/exponential-backoff.js';
import { createFixedBackoff } from '../../src/core/retry/fixed-backoff.js';
import { createUploadError } from '../../src/errors/upload-queue.error.js';

const occurredAt = '2026-08-13T15:00:00.000Z';

describe('additional classification and retry factories', () => {
  it('covers remaining HTTP classes', () => {
    expect(classifyHttpStatus(404, occurredAt).kind).toBe('validation');
    expect(classifyHttpStatus(409, occurredAt).retryable).toBe(false);
    expect(classifyHttpStatus(422, occurredAt).kind).toBe('validation');
    expect(classifyHttpStatus(418, occurredAt).retryable).toBe(false);
    expect(classifyHttpStatus(599, occurredAt).kind).toBe('server');
    expect(classifyHttpStatus(201, occurredAt).kind).toBe('unknown');
  });

  it('round-trips structured and generic errors', () => {
    const structured = createUploadError({
      kind: 'server',
      message: 'boom',
      retryable: true,
      occurredAt,
      statusCode: 503,
    });
    expect(toUploadError(structured, occurredAt).statusCode).toBe(503);
    expect(toUploadError(new Error('offline gateway'), occurredAt).kind).toBe('network');
    expect(toUploadError(new Error('bad payload'), occurredAt).kind).toBe('unknown');
    expect(toUploadError('nope', occurredAt).kind).toBe('unknown');
  });

  it('creates backoff strategies through factories', () => {
    expect(createExponentialBackoff({ jitter: false }).nextDelayMs(1)).toBe(2_000);
    expect(createFixedBackoff({ delayMs: 1_500 }).nextDelayMs(4)).toBe(1_500);
  });
});
