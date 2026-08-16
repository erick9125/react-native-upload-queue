import { describe, expect, it } from 'vitest';
import { appendUploadFile } from '../../src/adapters/http/multipart-body-builder.js';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createSQLiteUploadStorage } from '../../src/adapters/sqlite/sqlite-upload-storage.js';
import { mapUploadRow } from '../../src/adapters/sqlite/upload-row-mapper.js';
import type { SQLiteDriver } from '../../src/adapters/sqlite/driver.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import type { UploadTask } from '../../src/core/models/upload-task.js';
import { parseRetryAfterHeader } from '../../src/core/utils.js';
import { FileNotFoundError } from '../../src/errors/file-not-found.error.js';
import { UploadQueueError } from '../../src/errors/upload-queue.error.js';
import { createEnqueueInput } from '../helpers/enqueue.js';
import { createFakeSQLiteDriver } from '../helpers/fake-sqlite-driver.js';
import { createFakeTransport } from '../helpers/fake-transport.js';

function baseTask(overrides: Partial<UploadTask> = {}): UploadTask {
  return {
    id: 'upload-1',
    fileUri: 'file://photo.jpg',
    fileName: 'photo.jpg',
    destination: '/uploads',
    method: 'POST',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    idempotencyKey: 'idem-1',
    progress: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('default multipart body (M2)', () => {
  it('refuses to build a body outside React Native instead of uploading the URI string', () => {
    const form = new FormData();
    expect(() => appendUploadFile(form, baseTask(), 'file')).toThrowError(UploadQueueError);
    expect(() => appendUploadFile(form, baseTask(), 'file')).toThrowError(/buildBody/);
    expect([...form.keys()]).toHaveLength(0);
  });
});

describe('purging completed uploads (M6)', () => {
  it('ages rows by completedAt, not by the last time they were touched', async () => {
    const storage = createMemoryUploadStorage();
    await storage.initialize();

    // Finished long ago, but touched recently — it must still be purged.
    await storage.insert(
      baseTask({
        id: 'old-but-touched',
        status: 'completed',
        completedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    );
    // Finished recently — it must survive.
    await storage.insert(
      baseTask({
        id: 'recent',
        status: 'completed',
        completedAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    );

    expect(await storage.deleteCompleted('2026-03-01T00:00:00.000Z')).toBe(1);
    expect(await storage.get('old-but-touched')).toBeNull();
    expect(await storage.get('recent')).not.toBeNull();
  });
});

describe('row mapping (M7)', () => {
  it('falls back to the schema default for maxAttempts, never to zero', () => {
    const task = mapUploadRow({
      id: 'a',
      file_uri: 'file://a.jpg',
      file_name: 'a.jpg',
      destination: '/uploads',
      method: 'POST',
      status: 'pending',
      attempts: 0,
      max_attempts: null,
      idempotency_key: 'idem',
      progress: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    expect(task.maxAttempts).toBe(5);
    expect(task.attempts < task.maxAttempts).toBe(true);
  });
});

describe('insert error reporting (M8)', () => {
  it('surfaces an IO fault as itself rather than as a duplicate', async () => {
    const inner = createFakeSQLiteDriver();
    const driver: SQLiteDriver = {
      async execute(sql, params) {
        if (sql.trim().toLowerCase().startsWith('insert into upload_queue')) {
          throw new Error('disk I/O error');
        }
        return inner.execute(sql, params);
      },
    };

    const storage = createSQLiteUploadStorage({ driver });
    await storage.initialize();

    await expect(storage.insert(baseTask())).rejects.toThrowError(/disk I\/O error/);
  });

  it('still reports a genuine duplicate as a validation error', async () => {
    const storage = createSQLiteUploadStorage({ driver: createFakeSQLiteDriver() });
    await storage.initialize();

    await storage.insert(baseTask());
    await expect(storage.insert(baseTask())).rejects.toThrowError(/already queued/);
  });
});

describe('error messages (M9)', () => {
  it('names the missing file', () => {
    const error = new FileNotFoundError('file://gone.jpg');
    expect(error.message).toContain('file://gone.jpg');
    expect(error.fileUri).toBe('file://gone.jpg');
  });
});

describe('Retry-After parsing (M10)', () => {
  it('resolves an HTTP date against the supplied clock rather than the wall clock', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const parsed = parseRetryAfterHeader('Thu, 01 Jan 2026 00:00:30 GMT', now);
    expect(parsed).toBe(30_000);
  });

  it('never returns a negative delay for a date already in the past', () => {
    const now = new Date('2026-01-01T00:01:00.000Z');
    expect(parseRetryAfterHeader('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(0);
  });

  it('still reads plain seconds', () => {
    expect(parseRetryAfterHeader('12', new Date())).toBe(12_000);
  });
});

describe('result accounting and events (L1/L5/L6)', () => {
  it('carries the server response on the completed event', async () => {
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport: createFakeTransport(() => ({
        statusCode: 200,
        remoteId: 'remote-1',
        response: { id: 'remote-1', bytes: 42 },
      })),
    });

    const responses: unknown[] = [];
    queue.subscribe((event) => {
      if (event.type === 'upload.completed') {
        responses.push(event.response);
      }
    });

    await queue.enqueue(createEnqueueInput());
    await queue.process();

    expect(responses).toEqual([{ id: 'remote-1', bytes: 42 }]);
  });

  it('parks a 403 in blocked, like a 401, instead of failing it', async () => {
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport: createFakeTransport(() => ({ statusCode: 403 })),
      retry: { maxAttempts: 3, jitter: false },
    });

    const upload = await queue.enqueue(createEnqueueInput());
    const result = await queue.process();

    expect(result.blocked).toBe(1);
    const stored = await queue.get(upload.id);
    expect(stored?.status).toBe('blocked');
    expect(stored?.lastError?.kind).toBe('authorization');
  });

  it('does not count an upload another worker had already claimed', async () => {
    const base = createMemoryUploadStorage();
    const storage = {
      ...base,
      // Someone else got there first.
      async claim() {
        return null;
      },
    };

    const queue = createUploadQueue({ storage, transport: createFakeTransport() });
    await queue.enqueue(createEnqueueInput());
    const result = await queue.process();

    expect(result.processed).toBe(0);
    expect(result.deferred).toBe(0);
  });
});

describe('manual retry ergonomics (L4)', () => {
  it('accepts a retry on an upload that is still pending and resets its attempts', async () => {
    const storage = createMemoryUploadStorage();
    const queue = createUploadQueue({
      storage,
      transport: createFakeTransport(),
      retry: { maxAttempts: 3, jitter: false },
    });

    const upload = await queue.enqueue(createEnqueueInput());
    const stored = await storage.get(upload.id);
    await storage.update({ ...stored!, attempts: 2 });

    const retried = await queue.retry(upload.id);
    expect(retried.status).toBe('pending');
    expect(retried.attempts).toBe(0);
  });
});
