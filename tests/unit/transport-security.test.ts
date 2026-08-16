import { describe, expect, it } from 'vitest';
import {
  createHttpUploadTransport,
  type FetchLike,
} from '../../src/adapters/http/http-upload-transport.js';
import type { UploadTask } from '../../src/core/models/upload-task.js';
import { toUploadError } from '../../src/core/processor/upload-error-classifier.js';
import { UploadQueueError } from '../../src/errors/upload-queue.error.js';
import { buildTestBody } from '../helpers/body.js';

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function createRecordingFetch(
  calls: RecordedCall[],
  handler?: (signal: AbortSignal | undefined) => Promise<unknown>,
): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });

    // Real fetch rejects straight away on an already-aborted signal.
    if (init?.signal?.aborted) {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }

    if (handler) {
      await handler(init?.signal);
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      async text() {
        return JSON.stringify({ id: 'remote-1' });
      },
    };
  };
}

function task(destination: string): UploadTask {
  return {
    id: 'upload-1',
    fileUri: 'file://photo.jpg',
    fileName: 'photo.jpg',
    destination,
    method: 'POST',
    status: 'uploading',
    attempts: 0,
    maxAttempts: 5,
    idempotencyKey: 'idem-1',
    progress: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    size: 10,
  };
}

const noopContext = {
  signal: new AbortController().signal,
  onProgress: () => undefined,
};

describe('destination handling (A8)', () => {
  it('rejects an absolute destination by default', async () => {
    const calls: RecordedCall[] = [];
    const transport = createHttpUploadTransport({
      buildBody: buildTestBody,
      baseUrl: 'https://api.example.com',
      fetch: createRecordingFetch(calls),
      getAccessToken: async () => 'secret-token',
    });

    await expect(
      transport.upload(task('https://attacker.example/collect'), noopContext),
    ).rejects.toBeInstanceOf(UploadQueueError);
    expect(calls).toHaveLength(0);
  });

  it('never attaches the access token to a foreign origin when absolute destinations are allowed', async () => {
    const calls: RecordedCall[] = [];
    const transport = createHttpUploadTransport({
      buildBody: buildTestBody,
      baseUrl: 'https://api.example.com',
      fetch: createRecordingFetch(calls),
      getAccessToken: async () => 'secret-token',
      allowAbsoluteDestinations: true,
    });

    await transport.upload(task('https://attacker.example/collect'), noopContext);

    expect(calls[0]?.url).toBe('https://attacker.example/collect');
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it('attaches the access token for the base origin', async () => {
    const calls: RecordedCall[] = [];
    const transport = createHttpUploadTransport({
      buildBody: buildTestBody,
      baseUrl: 'https://api.example.com',
      fetch: createRecordingFetch(calls),
      getAccessToken: async () => 'secret-token',
    });

    await transport.upload(task('/uploads'), noopContext);

    expect(calls[0]?.url).toBe('https://api.example.com/uploads');
    expect(calls[0]?.headers.Authorization).toBe('Bearer secret-token');
  });
});

describe('deadlines (A6/A7)', () => {
  it('reports a timeout as a retryable network failure, not a cancellation', async () => {
    const calls: RecordedCall[] = [];
    const transport = createHttpUploadTransport({
      buildBody: buildTestBody,
      baseUrl: 'https://api.example.com',
      timeoutMs: 20,
      fetch: createRecordingFetch(calls, async (signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }),
    });

    const thrown = await transport
      .upload(task('/uploads'), noopContext)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UploadQueueError);
    const classified = toUploadError(thrown, '2026-01-01T00:00:00.000Z');
    expect(classified.kind).toBe('network');
    expect(classified.retryable).toBe(true);
  });

  it('still reports a caller cancellation as cancelled', async () => {
    const controller = new AbortController();
    const transport = createHttpUploadTransport({
      buildBody: buildTestBody,
      baseUrl: 'https://api.example.com',
      timeoutMs: 5_000,
      fetch: createRecordingFetch([], async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }),
    });

    const pending = transport.upload(task('/uploads'), {
      signal: controller.signal,
      onProgress: () => undefined,
    });
    controller.abort();

    const thrown = await pending.catch((error: unknown) => error);
    const classified = toUploadError(thrown, '2026-01-01T00:00:00.000Z');
    expect(classified.kind).toBe('cancelled');
    expect(classified.retryable).toBe(false);
  });

  it('does not leave the deadline timer or abort listener behind after a success', async () => {
    const controller = new AbortController();
    let listeners = 0;
    const signal = new Proxy(controller.signal, {
      get(target, property, receiver) {
        if (property === 'addEventListener') {
          return (...args: Parameters<AbortSignal['addEventListener']>) => {
            listeners += 1;
            return target.addEventListener(...args);
          };
        }
        if (property === 'removeEventListener') {
          return (...args: Parameters<AbortSignal['removeEventListener']>) => {
            listeners -= 1;
            return target.removeEventListener(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const transport = createHttpUploadTransport({
      buildBody: buildTestBody,
      baseUrl: 'https://api.example.com',
      timeoutMs: 10_000,
      fetch: createRecordingFetch([]),
    });

    await transport.upload(task('/uploads'), { signal, onProgress: () => undefined });

    expect(listeners).toBe(0);
  });

  it('classifies a TimeoutError from a custom fetch by name, not by message wording', () => {
    const error = new Error('bg upload deadline reached');
    error.name = 'TimeoutError';

    const classified = toUploadError(error, '2026-01-01T00:00:00.000Z');
    expect(classified.kind).toBe('network');
    expect(classified.retryable).toBe(true);
  });
});
