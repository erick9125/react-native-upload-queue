import { describe, expect, it } from 'vitest';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import { createEnqueueInput } from '../helpers/enqueue.js';
import { createScriptedTransport } from '../helpers/fake-transport.js';

describe('retry flow', () => {
  it('retries recoverable failures and keeps the same idempotency key', async () => {
    const transport = createScriptedTransport([
      () => new TypeError('network request failed'),
      () => ({ statusCode: 500 }),
      () => ({ statusCode: 200, remoteId: 'ok' }),
    ]);

    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      retry: { maxAttempts: 5, initialDelayMs: 0, jitter: false },
    });

    const upload = await queue.enqueue(createEnqueueInput());
    await queue.process();
    await queue.process();
    await queue.process();

    const completed = await queue.get(upload.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.attempts).toBe(3);
    expect(transport.calls).toHaveLength(3);
    expect(new Set(transport.calls.map((call) => call.idempotencyKey)).size).toBe(1);
    expect(transport.calls[0]?.idempotencyKey).toBe(upload.idempotencyKey);
  });

  it('blocks on 401 instead of retrying with the same token', async () => {
    let tokenReads = 0;
    const transport = createScriptedTransport([() => ({ statusCode: 401 })]);
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      retry: { maxAttempts: 5, initialDelayMs: 0, jitter: false },
    });

    const originalUpload = transport.upload.bind(transport);
    transport.upload = async (task, context) => {
      tokenReads += 1;
      return originalUpload(task, context);
    };

    const upload = await queue.enqueue(createEnqueueInput());
    await queue.process();
    await queue.process();

    const stored = await queue.get(upload.id);
    expect(stored?.status).toBe('blocked');
    expect(stored?.lastError?.kind).toBe('authentication');
    expect(transport.calls).toHaveLength(1);
    expect(tokenReads).toBe(1);
  });

  it('respects Retry-After over the local backoff', async () => {
    const transport = createScriptedTransport([
      () => ({ statusCode: 429, retryAfterMs: 30_000 }),
    ]);
    const events: Array<{ type: string; delayMs?: number }> = [];
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      retry: { maxAttempts: 5, initialDelayMs: 2_000, jitter: false },
    });
    queue.subscribe((event) => {
      if (event.type === 'upload.retry_scheduled') {
        events.push({ type: event.type, delayMs: event.delayMs });
      }
    });

    const upload = await queue.enqueue(createEnqueueInput());
    await queue.process();
    const stored = await queue.get(upload.id);
    expect(stored?.status).toBe('pending');
    expect(events[0]?.delayMs).toBe(30_000);
  });

  it('fails missing files without retrying', async () => {
    const { createMemoryFileProvider } = await import(
      '../../src/adapters/memory/memory-file-provider.js'
    );
    const files = createMemoryFileProvider({ 'file://missing.pdf': { missing: true } });
    const transport = createScriptedTransport([() => ({ statusCode: 200 })]);
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      fileProvider: files,
      retry: { maxAttempts: 5, jitter: false },
    });

    const upload = await queue.enqueue(
      createEnqueueInput({ fileUri: 'file://missing.pdf', fileName: 'missing.pdf' }),
    );
    await queue.process();
    const stored = await queue.get(upload.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.lastError?.kind).toBe('file-not-found');
    expect(transport.calls).toHaveLength(0);
  });
});
