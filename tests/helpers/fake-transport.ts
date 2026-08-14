import type { UploadTransport, UploadTransportResult } from '../../src/core/contracts/upload-transport.js';
import type { UploadTask } from '../../src/core/models/upload-task.js';

export interface FakeTransportCall {
  readonly task: UploadTask;
  readonly idempotencyKey: string;
}

export function createFakeTransport(
  handler: (
    task: UploadTask,
    context: { signal: AbortSignal; onProgress: (bytesUploaded: number, totalBytes?: number) => void },
  ) => Promise<UploadTransportResult> | UploadTransportResult = () => ({
    statusCode: 200,
    remoteId: 'remote-1',
  }),
): UploadTransport & {
  readonly calls: FakeTransportCall[];
  readonly active: number;
  readonly peakActive: number;
  waitForActive(count: number, timeoutMs?: number): Promise<void>;
} {
  const calls: FakeTransportCall[] = [];
  let active = 0;
  let peakActive = 0;
  const waiters: Array<() => void> = [];

  const notify = (): void => {
    for (const waiter of waiters) {
      waiter();
    }
  };

  const transport: UploadTransport & {
    readonly calls: FakeTransportCall[];
    readonly active: number;
    readonly peakActive: number;
    waitForActive(count: number, timeoutMs?: number): Promise<void>;
  } = {
    get calls() {
      return calls;
    },
    get active() {
      return active;
    },
    get peakActive() {
      return peakActive;
    },
    async waitForActive(count: number, timeoutMs = 1_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (active < count) {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${count} active uploads (had ${active})`);
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 10);
        });
      }
    },
    async upload(task, context): Promise<UploadTransportResult> {
      active += 1;
      peakActive = Math.max(peakActive, active);
      calls.push({ task, idempotencyKey: task.idempotencyKey });
      notify();
      try {
        if (context.signal.aborted) {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        }

        return await handler(task, context);
      } finally {
        active -= 1;
      }
    },
  };

  return transport;
}

export function createScriptedTransport(
  scripts: Array<
    () => Promise<UploadTransportResult> | UploadTransportResult | Error | TypeError
  >,
): ReturnType<typeof createFakeTransport> {
  let index = 0;
  return createFakeTransport(async () => {
    const script = scripts[index] ?? scripts[scripts.length - 1];
    index += 1;
    if (!script) {
      return { statusCode: 200 };
    }

    const result = await script();
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
}
