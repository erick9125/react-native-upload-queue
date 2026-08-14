import { describe, expect, it } from 'vitest';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import { createEnqueueInput } from '../helpers/enqueue.js';
import { createFakeTransport } from '../helpers/fake-transport.js';
import { delay } from '../helpers/clock.js';

describe('concurrency', () => {
  it('never exceeds the configured concurrency limit', async () => {
    const transport = createFakeTransport(async () => {
      await delay(40);
      return { statusCode: 200 };
    });

    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      concurrency: 3,
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        queue.enqueue(
          createEnqueueInput({
            fileName: `file-${index}.bin`,
            fileUri: `file://file-${index}.bin`,
          }),
        ),
      ),
    );

    await queue.process();
    expect(transport.peakActive).toBe(3);
    expect(transport.calls).toHaveLength(20);
    const remaining = (await queue.list()).filter((task) => task.status !== 'completed');
    expect(remaining).toHaveLength(0);
  });

  it('does not duplicate uploads when process() is called concurrently', async () => {
    const transport = createFakeTransport(async () => {
      await delay(20);
      return { statusCode: 200 };
    });

    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      concurrency: 2,
    });

    const first = await queue.enqueue(createEnqueueInput({ fileName: 'one.jpg' }));
    const second = await queue.enqueue(
      createEnqueueInput({ fileName: 'two.jpg', fileUri: 'file://two.jpg' }),
    );

    await Promise.all([queue.process(), queue.process(), queue.process()]);

    const ids = transport.calls.map((call) => call.task.id).sort();
    expect(ids).toEqual([first.id, second.id].sort());
    expect(transport.calls).toHaveLength(2);
  });
});
