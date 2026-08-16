import { describe, expect, it } from 'vitest';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createSQLiteUploadStorage } from '../../src/adapters/sqlite/sqlite-upload-storage.js';
import type { SQLiteDriver, SQLiteQueryResult } from '../../src/adapters/sqlite/driver.js';
import type { UploadStorage } from '../../src/core/contracts/upload-storage.js';
import type { UploadTask } from '../../src/core/models/upload-task.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import { delay } from '../helpers/clock.js';
import { createEnqueueInput } from '../helpers/enqueue.js';
import { createFakeSQLiteDriver } from '../helpers/fake-sqlite-driver.js';
import { createFakeTransport } from '../helpers/fake-transport.js';

/** Wraps a driver so a test can assert on the SQL actually issued. */
function createSpyDriver(inner: SQLiteDriver): SQLiteDriver & { readonly sql: string[] } {
  const sql: string[] = [];
  return {
    get sql() {
      return sql;
    },
    async execute(statement: string, params?: readonly unknown[]): Promise<SQLiteQueryResult> {
      sql.push(statement.replace(/\s+/g, ' ').trim().toLowerCase());
      return inner.execute(statement, params);
    },
  };
}

function historicalTask(index: number): UploadTask {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `history-${index}`,
    fileUri: `file://history-${index}.jpg`,
    fileName: `history-${index}.jpg`,
    destination: '/uploads',
    method: 'POST',
    status: 'completed',
    attempts: 1,
    maxAttempts: 5,
    idempotencyKey: `history-${index}`,
    progress: 1,
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    metadata: { index },
  };
}

describe('wake scheduling (A1/A2)', () => {
  it('reads only the earliest retry instead of loading the queue', async () => {
    const spy = createSpyDriver(createFakeSQLiteDriver());
    const storage = createSQLiteUploadStorage({ driver: spy });
    await storage.initialize();

    for (let index = 0; index < 25; index += 1) {
      await storage.insert(historicalTask(index));
    }

    const queue = createUploadQueue({ storage, transport: createFakeTransport() });
    await queue.start();

    expect(spy.sql.some((statement) => statement.startsWith('select min(next_attempt_at)'))).toBe(
      true,
    );
    expect(
      spy.sql.some((statement) => statement.startsWith('select * from upload_queue order by')),
    ).toBe(false);

    await queue.destroy();
  });

  it('reports the earliest scheduled retry across pending uploads', async () => {
    const storage = createMemoryUploadStorage();
    await storage.initialize();

    expect(await storage.getEarliestNextAttemptAt()).toBeNull();

    await storage.insert({
      ...historicalTask(1),
      id: 'later',
      status: 'pending',
      nextAttemptAt: '2026-03-01T00:00:00.000Z',
    });
    await storage.insert({
      ...historicalTask(2),
      id: 'sooner',
      status: 'pending',
      nextAttemptAt: '2026-02-01T00:00:00.000Z',
    });
    await storage.insert({
      ...historicalTask(3),
      id: 'completed-with-schedule',
      status: 'completed',
      nextAttemptAt: '2026-01-01T00:00:00.000Z',
    });

    expect(await storage.getEarliestNextAttemptAt()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('picks up an upload enqueued while a drain is already running', async () => {
    const storage = createMemoryUploadStorage();
    const transport = createFakeTransport(async () => {
      await delay(60);
      return { statusCode: 200, remoteId: 'ok' };
    });
    const queue = createUploadQueue({ storage, transport, concurrency: 1 });

    const first = await queue.enqueue(createEnqueueInput({ fileName: 'first.jpg' }));
    const running = queue.process();

    // Lands while the pass above is mid-flight; it has no nextAttemptAt, so the
    // wake timer would never fire for it.
    await delay(20);
    const second = await queue.enqueue(
      createEnqueueInput({ fileName: 'second.jpg', fileUri: 'file://second.jpg' }),
    );

    await running;

    expect((await queue.get(first.id))?.status).toBe('completed');
    expect((await queue.get(second.id))?.status).toBe('completed');
  });
});

describe('recovery of abandoned uploads (A3)', () => {
  it('recovers every stale upload in a single statement', async () => {
    const spy = createSpyDriver(createFakeSQLiteDriver());
    const storage = createSQLiteUploadStorage({ driver: spy });
    await storage.initialize();

    const crashedAt = '2026-01-01T00:00:00.000Z';
    for (let index = 0; index < 5; index += 1) {
      await storage.insert({
        ...historicalTask(index),
        status: 'uploading',
        processingToken: `dead-${index}`,
        processingStartedAt: crashedAt,
        progress: 0.4,
      });
    }

    const recovered = await storage.recoverAbandoned('2026-06-01T00:00:00.000Z', crashedAt);
    expect(recovered).toBe(5);

    const writes = spy.sql.filter((statement) => statement.startsWith('update upload_queue'));
    expect(writes).toHaveLength(1);

    const tasks = await storage.list();
    expect(tasks.every((task) => task.status === 'pending')).toBe(true);
    expect(tasks.every((task) => task.processingToken === undefined)).toBe(true);
    expect(tasks.every((task) => task.progress === 0)).toBe(true);
  });

  it('leaves uploads that are still within the processing timeout alone', async () => {
    const storage = createMemoryUploadStorage();
    await storage.initialize();
    await storage.insert({
      ...historicalTask(0),
      status: 'uploading',
      processingToken: 'alive',
      processingStartedAt: '2026-06-01T00:00:00.000Z',
    });

    expect(await storage.recoverAbandoned('2026-01-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z')).toBe(0);
    expect((await storage.get('history-0'))?.status).toBe('uploading');
  });
});

describe('progress persistence (A5)', () => {
  it('writes only the progress columns and stays fenced on the claim', async () => {
    const spy = createSpyDriver(createFakeSQLiteDriver());
    const storage: UploadStorage = createSQLiteUploadStorage({ driver: spy });
    await storage.initialize();

    const queue = createUploadQueue({
      storage,
      transport: createFakeTransport(async (_task, context) => {
        context.onProgress(256, 1_024);
        context.onProgress(512, 1_024);
        context.onProgress(1_024, 1_024);
        return { statusCode: 200 };
      }),
      progress: { eventThrottleMs: 0, persistEveryMs: 0, persistEveryPercent: 0 },
    });

    await queue.enqueue(createEnqueueInput());
    await queue.process();

    const progressWrites = spy.sql.filter((statement) =>
      statement.startsWith('update upload_queue set progress = ?'),
    );
    expect(progressWrites.length).toBeGreaterThan(0);
    expect(progressWrites.every((statement) => statement.includes('processing_token = ?'))).toBe(true);
    expect(progressWrites.every((statement) => !statement.includes('metadata'))).toBe(true);

    await queue.destroy();
  });

  it('refuses a progress write from a worker that no longer holds the claim', async () => {
    const storage = createMemoryUploadStorage();
    await storage.initialize();
    await storage.insert({ ...historicalTask(0), status: 'pending' });

    const claimed = await storage.claim('history-0', 'token-a', '2026-06-01T00:00:00.000Z');
    expect(claimed).not.toBeNull();

    const mine = await storage.updateProgress({
      id: 'history-0',
      processingToken: 'token-a',
      progress: 0.5,
      bytesUploaded: 512,
      updatedAt: '2026-06-01T00:00:01.000Z',
    });
    expect(mine).toBe(true);

    const stale = await storage.updateProgress({
      id: 'history-0',
      processingToken: 'token-b',
      progress: 0.9,
      bytesUploaded: 900,
      updatedAt: '2026-06-01T00:00:02.000Z',
    });
    expect(stale).toBe(false);
    expect((await storage.get('history-0'))?.progress).toBe(0.5);
  });
});
