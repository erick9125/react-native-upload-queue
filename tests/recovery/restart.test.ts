import { describe, expect, it } from 'vitest';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createSQLiteUploadStorage } from '../../src/adapters/sqlite/sqlite-upload-storage.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import { createEnqueueInput } from '../helpers/enqueue.js';
import { createFakeSQLiteDriver } from '../helpers/fake-sqlite-driver.js';
import { createFakeTransport } from '../helpers/fake-transport.js';

describe('recovery after restart', () => {
  it('recovers an abandoned upload and completes it in a new process', async () => {
    const storage = createMemoryUploadStorage();
    const processA = createUploadQueue({
      storage,
      transport: createFakeTransport(),
    });

    const upload = await processA.enqueue(createEnqueueInput());
    const queued = await storage.get(upload.id);
    const crashedAt = new Date(Date.now() - 10 * 60_000).toISOString();

    await storage.update({
      ...queued!,
      status: 'uploading',
      processingToken: 'dead-worker',
      processingStartedAt: crashedAt,
      updatedAt: crashedAt,
      progress: 0.53,
    });

    const processB = createUploadQueue({
      storage,
      transport: createFakeTransport(() => ({ statusCode: 200, remoteId: 'recovered' })),
      recovery: { processingTimeoutMs: 5 * 60_000 },
    });

    await processB.initialize();
    const recovered = await processB.get(upload.id);
    expect(recovered?.status).toBe('pending');
    expect(recovered?.idempotencyKey).toBe(upload.idempotencyKey);

    await processB.process();
    const completed = await processB.get(upload.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.remoteId).toBe('recovered');
    expect(completed?.idempotencyKey).toBe(upload.idempotencyKey);
  });

  it('does not recover an upload that is still within the processing timeout', async () => {
    const storage = createSQLiteUploadStorage({ driver: createFakeSQLiteDriver() });
    await storage.initialize();
    const now = new Date().toISOString();
    await storage.insert({
      id: 'fresh',
      fileUri: 'file://fresh.jpg',
      fileName: 'fresh.jpg',
      destination: '/uploads',
      method: 'POST',
      status: 'uploading',
      attempts: 0,
      maxAttempts: 5,
      idempotencyKey: 'fresh-key',
      progress: 0.53,
      createdAt: now,
      updatedAt: now,
      processingToken: 'worker-1',
      processingStartedAt: now,
    });

    const queue = createUploadQueue({
      storage,
      transport: createFakeTransport(),
      recovery: { processingTimeoutMs: 5 * 60_000 },
    });

    await queue.initialize();
    const stored = await queue.get('fresh');
    expect(stored?.status).toBe('uploading');
    expect(stored?.progress).toBe(0.53);
  });
});
