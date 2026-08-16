import { describe, expect, it } from 'vitest';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createSQLiteUploadStorage } from '../../src/adapters/sqlite/sqlite-upload-storage.js';
import type { UploadStorage } from '../../src/core/contracts/upload-storage.js';
import type { UploadTransport } from '../../src/core/contracts/upload-transport.js';
import type { UploadTask } from '../../src/core/models/upload-task.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import { delay } from '../helpers/clock.js';
import { createEnqueueInput } from '../helpers/enqueue.js';
import { createFakeSQLiteDriver } from '../helpers/fake-sqlite-driver.js';
import { createFakeTransport } from '../helpers/fake-transport.js';

/** A transport that ignores context.signal, like a native background uploader. */
function createUncancellableTransport(statusCode: number, durationMs = 60): UploadTransport {
  return {
    async upload() {
      await delay(durationMs);
      return { statusCode };
    },
  };
}

describe('claim ownership (C1/C2)', () => {
  it('keeps an upload paused when an attempt it cannot cancel fails afterwards', async () => {
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport: createUncancellableTransport(500),
      retry: { maxAttempts: 5, initialDelayMs: 1_000, jitter: false },
    });

    const upload = await queue.enqueue(createEnqueueInput());
    const running = queue.process();
    await delay(20);
    await queue.pause(upload.id);
    await running;

    const task = await queue.get(upload.id);
    expect(task?.status).toBe('paused');
    expect(task?.attempts).toBe(0);
  });

  it('keeps an upload cancelled when an attempt it cannot cancel succeeds afterwards', async () => {
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport: createUncancellableTransport(200),
      retry: { maxAttempts: 5, jitter: false },
    });

    const upload = await queue.enqueue(createEnqueueInput());
    const running = queue.process();
    await delay(20);
    await queue.cancel(upload.id);
    await running;

    const task = await queue.get(upload.id);
    expect(task?.status).toBe('cancelled');
    expect(task?.remoteId).toBeUndefined();
  });
});

describe('resilience of the drain loop (C3/C4)', () => {
  it('finishes the batch and reports the fault when one upload throws', async () => {
    const base = createMemoryUploadStorage();
    // Which upload blows up is only known once it has an id, hence the holder.
    const poison = { id: '' };

    const storage: UploadStorage = {
      ...base,
      async claim(id, token, nowIso) {
        if (id === poison.id) {
          throw new Error('database disk image is malformed');
        }
        return base.claim(id, token, nowIso);
      },
    };

    const transport = createFakeTransport(() => ({ statusCode: 200, remoteId: 'ok' }));
    const queue = createUploadQueue({ storage, transport, concurrency: 2 });

    const poisoned = await queue.enqueue(createEnqueueInput({ fileName: 'poison.jpg' }));
    poison.id = poisoned.id;
    const healthy = await queue.enqueue(
      createEnqueueInput({ fileName: 'healthy.jpg', fileUri: 'file://healthy.jpg' }),
    );

    const result = await queue.process();

    expect(result.errored).toBe(1);
    expect(result.completed).toBe(1);
    expect((await queue.get(healthy.id))?.status).toBe('completed');
    expect((await queue.get(poisoned.id))?.status).toBe('pending');
  });
});

describe('shutdown (C5)', () => {
  it('drains in-flight uploads before storage is closed and releases them to pending', async () => {
    const base = createMemoryUploadStorage();
    let closed = false;

    const guard = (): void => {
      if (closed) {
        throw new Error('database is not open');
      }
    };

    const storage: UploadStorage = {
      ...base,
      async update(task: UploadTask) {
        guard();
        return base.update(task);
      },
      async updateOwned(task: UploadTask, token: string) {
        guard();
        return base.updateOwned(task, token);
      },
      async close() {
        closed = true;
      },
    };

    const queue = createUploadQueue({
      storage,
      transport: createFakeTransport(async (_task, context) => {
        await delay(300);
        if (context.signal.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        return { statusCode: 200 };
      }),
      concurrency: 1,
    });

    const upload = await queue.enqueue(createEnqueueInput());
    const running = queue.process();
    await delay(40);
    await queue.destroy();

    await expect(running).resolves.toBeDefined();

    // Read past the guard: the row must be back in the pool, not stuck uploading
    // and not charged an attempt for a shutdown it did not cause.
    const task = await base.get(upload.id);
    expect(task?.status).toBe('pending');
    expect(task?.attempts).toBe(0);
    expect(task?.processingToken).toBeUndefined();
  });
});

describe('concurrent claims on a single-connection driver (C6)', () => {
  it('processes a batch with concurrency > 1 without overlapping transactions', async () => {
    const storage = createSQLiteUploadStorage({ driver: createFakeSQLiteDriver() });
    const transport = createFakeTransport(async () => {
      await delay(30);
      return { statusCode: 200, remoteId: 'ok' };
    });

    const queue = createUploadQueue({ storage, transport, concurrency: 3 });

    for (let index = 0; index < 6; index += 1) {
      await queue.enqueue(
        createEnqueueInput({ fileName: `file-${index}.bin`, fileUri: `file://file-${index}.bin` }),
      );
    }

    const result = await queue.process();

    expect(result.errored).toBe(0);
    expect(result.completed).toBe(6);
    expect(transport.peakActive).toBe(3);
    const stranded = (await queue.list()).filter((task) => task.status !== 'completed');
    expect(stranded).toHaveLength(0);
  });
});
