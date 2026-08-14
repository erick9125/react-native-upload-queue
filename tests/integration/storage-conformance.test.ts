import { describe, expect, it } from 'vitest';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createSQLiteUploadStorage } from '../../src/adapters/sqlite/sqlite-upload-storage.js';
import type { UploadStorage } from '../../src/core/contracts/upload-storage.js';
import type { UploadTask } from '../../src/core/models/upload-task.js';
import { createFakeSQLiteDriver } from '../helpers/fake-sqlite-driver.js';
import { createRealSQLiteDriver } from '../helpers/node-sqlite-driver.js';

function sampleTask(overrides: Partial<UploadTask> = {}): UploadTask {
  return {
    id: overrides.id ?? 'upload-1',
    fileUri: 'file://invoice.pdf',
    fileName: 'invoice.pdf',
    destination: '/documents',
    method: 'POST',
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? 0,
    maxAttempts: 5,
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    progress: overrides.progress ?? 0,
    createdAt: overrides.createdAt ?? '2026-08-13T15:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-08-13T15:00:00.000Z',
    mimeType: 'application/pdf',
    size: 2048,
    metadata: { documentType: 'invoice' },
    ...(overrides.lastError !== undefined ? { lastError: overrides.lastError } : {}),
    ...(overrides.nextAttemptAt !== undefined ? { nextAttemptAt: overrides.nextAttemptAt } : {}),
    ...(overrides.processingToken !== undefined
      ? { processingToken: overrides.processingToken }
      : {}),
    ...(overrides.processingStartedAt !== undefined
      ? { processingStartedAt: overrides.processingStartedAt }
      : {}),
  };
}

function storageSuites(): Array<{ name: string; create: () => Promise<UploadStorage> }> {
  return [
    {
      name: 'MemoryUploadStorage',
      create: async () => createMemoryUploadStorage(),
    },
    {
      name: 'SQLiteUploadStorage (fake driver)',
      create: async () => createSQLiteUploadStorage({ driver: createFakeSQLiteDriver() }),
    },
  ];
}

describe.each(storageSuites())('$name', ({ create }) => {
  it('persists and reads an upload', async () => {
    const storage = await create();
    await storage.initialize();
    const task = sampleTask();
    await storage.insert(task);
    const loaded = await storage.get(task.id);
    expect(loaded?.fileName).toBe('invoice.pdf');
    expect(loaded?.idempotencyKey).toBe('idem-1');
    expect(loaded?.metadata).toEqual({ documentType: 'invoice' });
  });

  it('updates status while preserving the idempotency key and metadata', async () => {
    const storage = await create();
    await storage.initialize();
    const task = sampleTask();
    await storage.insert(task);
    await storage.update({
      ...task,
      status: 'failed',
      attempts: 2,
      lastError: {
        kind: 'server',
        message: 'boom',
        retryable: true,
        occurredAt: task.updatedAt,
        statusCode: 500,
      },
    });
    const loaded = await storage.get(task.id);
    expect(loaded?.status).toBe('failed');
    expect(loaded?.attempts).toBe(2);
    expect(loaded?.idempotencyKey).toBe('idem-1');
    expect(loaded?.metadata).toEqual({ documentType: 'invoice' });
    expect(loaded?.lastError?.kind).toBe('server');
  });

  it('orders pending uploads and respects nextAttemptAt', async () => {
    const storage = await create();
    await storage.initialize();
    await storage.insert(sampleTask({ id: 'b', createdAt: '2026-08-13T15:00:02.000Z' }));
    await storage.insert(sampleTask({ id: 'a', createdAt: '2026-08-13T15:00:01.000Z' }));
    await storage.insert(
      sampleTask({
        id: 'later',
        createdAt: '2026-08-13T15:00:00.000Z',
        nextAttemptAt: '2026-08-13T16:00:00.000Z',
      }),
    );

    const pending = await storage.getPending(10, '2026-08-13T15:00:03.000Z');
    expect(pending.map((task) => task.id)).toEqual(['a', 'b']);
  });

  it('claims a pending upload exactly once', async () => {
    const storage = await create();
    await storage.initialize();
    await storage.insert(sampleTask());
    const first = await storage.claim('upload-1', 'token-a', '2026-08-13T15:00:05.000Z');
    const second = await storage.claim('upload-1', 'token-b', '2026-08-13T15:00:06.000Z');
    expect(first?.status).toBe('uploading');
    expect(first?.processingToken).toBe('token-a');
    expect(second).toBeNull();
  });

  it('deletes completed rows', async () => {
    const storage = await create();
    await storage.initialize();
    await storage.insert(sampleTask({ status: 'completed' }));
    expect(await storage.deleteCompleted()).toBe(1);
    expect(await storage.get('upload-1')).toBeNull();
  });
});

describe('SQLiteUploadStorage with node:sqlite', () => {
  it('persists through a real engine when available', async () => {
    const handle = await createRealSQLiteDriver();
    if (!handle) {
      return;
    }

    const storage = createSQLiteUploadStorage({ driver: handle.driver });
    await storage.initialize();
    await storage.insert(sampleTask());
    const loaded = await storage.get('upload-1');
    expect(loaded?.fileName).toBe('invoice.pdf');
    await storage.close?.();
  });
});
