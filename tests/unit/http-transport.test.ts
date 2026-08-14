import { describe, expect, it } from 'vitest';
import { createHttpUploadTransport } from '../../src/adapters/http/http-upload-transport.js';
import type { FetchLike } from '../../src/adapters/http/http-upload-transport.js';
import { createMemoryUploadStorage } from '../../src/adapters/memory/memory-upload-storage.js';
import { createUploadQueue } from '../../src/core/queue/upload-queue.js';
import { createEnqueueInput } from '../helpers/enqueue.js';

describe('createHttpUploadTransport', () => {
  it('sends a stable Idempotency-Key and a fresh access token on every attempt', async () => {
    const requests: Array<{ headers: Record<string, string>; method: string; url: string }> = [];
    let tokens = 0;

    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
      });
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        async text() {
          return JSON.stringify({ id: 'remote-42' });
        },
      };
    };

    const transport = createHttpUploadTransport({
      baseUrl: 'https://api.example.com',
      fetch: fetchImpl,
      getAccessToken: async () => {
        tokens += 1;
        return `token-${tokens}`;
      },
    });

    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
    });

    const upload = await queue.enqueue(createEnqueueInput({ destination: '/documents' }));
    await queue.process();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.example.com/documents');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['Idempotency-Key']).toBe(upload.idempotencyKey);
    expect(requests[0]?.headers.Authorization).toBe('Bearer token-1');
    expect(tokens).toBe(1);

    const stored = await queue.get(upload.id);
    expect(stored?.remoteId).toBe('remote-42');
    expect(JSON.stringify(stored)).not.toContain('token-1');
  });

  it('parses Retry-After from HTTP responses', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 429,
      ok: false,
      headers: {
        get(name: string) {
          return name.toLowerCase() === 'retry-after' ? '12' : null;
        },
      },
      async text() {
        return 'slow down';
      },
    });

    const transport = createHttpUploadTransport({
      baseUrl: 'https://api.example.com',
      fetch: fetchImpl,
    });

    const queue = createUploadQueue({
      storage: createMemoryUploadStorage(),
      transport,
      retry: { maxAttempts: 3, initialDelayMs: 1_000, jitter: false },
    });

    const upload = await queue.enqueue(createEnqueueInput());
    await queue.process();
    const stored = await queue.get(upload.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.lastError?.kind).toBe('rate-limit');
    expect(stored?.lastError?.retryAfterMs).toBe(12_000);
  });
});
