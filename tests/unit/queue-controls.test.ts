import { describe, expect, it } from 'vitest';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import { UploadNotFoundError } from '../../src/errors/upload-not-found.error.js';
import { delay } from '../helpers/clock.js';
import { createEnqueueInput } from '../helpers/enqueue.js';
import { createFakeTransport } from '../helpers/fake-transport.js';

describe('queue controls', () => {
  it('pauses an in-flight upload via AbortController', async () => {
    const transport = createFakeTransport(async (_task, context) => {
      await delay(80);
      if (context.signal.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return { statusCode: 200 };
    });

    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      concurrency: 1,
    });

    const upload = await queue.enqueue(createEnqueueInput());
    const processing = queue.process();
    await transport.waitForActive(1);
    const paused = await queue.pause(upload.id);
    expect(paused.status).toBe('paused');
    await processing;
    expect((await queue.get(upload.id))?.status).toBe('paused');
  });

  it('purges completed uploads and throws when the id is unknown', async () => {
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport: createFakeTransport(),
    });

    const upload = await queue.enqueue(createEnqueueInput());
    await queue.process();
    expect(await queue.purgeCompleted()).toBe(1);
    expect(await queue.get(upload.id)).toBeNull();
    await expect(queue.pause('missing')).rejects.toBeInstanceOf(UploadNotFoundError);
  });

  it('start processes due work and stop prevents automatic scheduling', async () => {
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport: createFakeTransport(),
    });

    const upload = await queue.enqueue(createEnqueueInput());
    await queue.start();
    expect((await queue.get(upload.id))?.status).toBe('completed');
    await queue.stop();
    await queue.destroy();
  });
});
