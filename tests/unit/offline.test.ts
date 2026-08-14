import { describe, expect, it } from 'vitest';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createManualConnectivity } from '../../src/adapters/netinfo/netinfo-connectivity-provider.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import { createEnqueueInput } from '../helpers/enqueue.js';
import { createFakeTransport } from '../helpers/fake-transport.js';

describe('offline behaviour', () => {
  it('does not consume retries while offline', async () => {
    const connectivity = createManualConnectivity(false);
    const transport = createFakeTransport();
    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      connectivity,
      retry: { maxAttempts: 5, jitter: false },
    });

    const upload = await queue.enqueue(createEnqueueInput());
    const result = await queue.process();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('offline');
    expect(transport.calls).toHaveLength(0);

    const stored = await queue.get(upload.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.attempts).toBe(0);

    connectivity.setOnline(true);
    await queue.process();
    const completed = await queue.get(upload.id);
    expect(completed?.status).toBe('completed');
    expect(transport.calls).toHaveLength(1);
  });
});
