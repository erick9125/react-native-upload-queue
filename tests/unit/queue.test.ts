import { describe, expect, it } from 'vitest';
import { createMemoryFileProvider } from '../../src/adapters/memory/memory-file-provider.js';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import { InvalidUploadStateError } from '../../src/errors/invalid-upload-state.error.js';
import { FileNotFoundError } from '../../src/errors/file-not-found.error.js';
import { createEnqueueInput } from '../helpers/enqueue.js';
import { createFakeTransport } from '../helpers/fake-transport.js';
import { delay } from '../helpers/clock.js';

function createQueue() {
  const transport = createFakeTransport(async (_task, context) => {
    await delay(40);
    if (context.signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    return { statusCode: 200, remoteId: 'ok' };
  });

  const queue = createUploadQueue({
    storage: createMemoryUploadStorage(),
    transport,
    concurrency: 1,
    retry: { maxAttempts: 3, initialDelayMs: 0, jitter: false },
  });

  return { queue, transport };
}

describe('UploadQueue', () => {
  it('enqueues an upload as pending and returns its id', async () => {
    const { queue } = createQueue();
    const upload = await queue.enqueue(createEnqueueInput());
    expect(upload.id).toBeTruthy();
    expect(upload.status).toBe('pending');
    expect(upload.attempts).toBe(0);
    expect(upload.idempotencyKey).toBeTruthy();
  });

  it('pauses a pending upload without uploading it', async () => {
    const { queue, transport } = createQueue();
    const upload = await queue.enqueue(createEnqueueInput());
    const paused = await queue.pause(upload.id);
    expect(paused.status).toBe('paused');
    await queue.process();
    expect(transport.calls).toHaveLength(0);
    const stored = await queue.get(upload.id);
    expect(stored?.status).toBe('paused');
  });

  it('resumes a paused upload to pending rather than uploading immediately', async () => {
    const { queue } = createQueue();
    const upload = await queue.enqueue(createEnqueueInput());
    await queue.pause(upload.id);
    const resumed = await queue.resume(upload.id);
    expect(resumed.status).toBe('pending');
  });

  it('cancels an upload without deleting the original file', async () => {
    const files = createMemoryFileProvider({ 'file://photo.jpg': { size: 10 } });
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport: createFakeTransport(),
      fileProvider: files,
    });
    const upload = await queue.enqueue(createEnqueueInput());
    const cancelled = await queue.cancel(upload.id);
    expect(cancelled.status).toBe('cancelled');
    expect(await files.exists('file://photo.jpg')).toBe(true);
    await expect(queue.pause(upload.id)).rejects.toBeInstanceOf(InvalidUploadStateError);
  });

  it('retries a failed upload after validating the file still exists', async () => {
    const files = createMemoryFileProvider({ 'file://photo.jpg': { size: 10 } });
    const transport = createFakeTransport(() => ({ statusCode: 400 }));
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      fileProvider: files,
      retry: { maxAttempts: 1, jitter: false },
    });

    const upload = await queue.enqueue(createEnqueueInput());
    await queue.process();
    const failed = await queue.get(upload.id);
    expect(failed?.status).toBe('failed');

    const retried = await queue.retry(upload.id);
    expect(retried.status).toBe('pending');
    expect(retried.attempts).toBe(0);
  });

  it('rejects manual retry when the file is gone', async () => {
    const files = createMemoryFileProvider({ 'file://photo.jpg': { size: 10 } });
    const transport = createFakeTransport(() => ({ statusCode: 400 }));
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      fileProvider: files,
      retry: { maxAttempts: 1, jitter: false },
    });

    const upload = await queue.enqueue(createEnqueueInput());
    await queue.process();
    files.remove('file://photo.jpg');
    await expect(queue.retry(upload.id)).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it('emits queued, started, progress and completed events', async () => {
    const transport = createFakeTransport(async (_task, context) => {
      context.onProgress(512, 1_024);
      context.onProgress(1_024, 1_024);
      return { statusCode: 200, remoteId: 'remote-9' };
    });
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      progress: { eventThrottleMs: 0, persistEveryMs: 0, persistEveryPercent: 0 },
    });

    const events: string[] = [];
    queue.subscribe((event) => {
      events.push(event.type);
    });

    const upload = await queue.enqueue(createEnqueueInput());
    await queue.process();
    const completed = await queue.get(upload.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.remoteId).toBe('remote-9');
    expect(events).toContain('upload.queued');
    expect(events).toContain('upload.started');
    expect(events).toContain('upload.progress');
    expect(events).toContain('upload.completed');
  });
});
