import type { Clock } from '../contracts/clock.js';
import { createSystemClock } from '../contracts/clock.js';
import type { ConnectivityProvider } from '../contracts/connectivity-provider.js';
import type { FileProvider } from '../contracts/file-provider.js';
import type { Logger } from '../contracts/logger.js';
import { createNoopLogger } from '../contracts/logger.js';
import type { RetryConfig, RetryStrategy } from '../contracts/retry-strategy.js';
import type { UploadStorage } from '../contracts/upload-storage.js';
import type { UploadTransport } from '../contracts/upload-transport.js';
import { UploadEventEmitter, type UploadEventListener } from '../events/upload-event-emitter.js';
import type { UploadProcessResult } from '../models/upload-result.js';
import type { UploadStatus } from '../models/upload-status.js';
import type { EnqueueUploadInput, UploadTask } from '../models/upload-task.js';
import { UploadErrorClassifier } from '../processor/upload-error-classifier.js';
import { UploadProcessor } from '../processor/upload-processor.js';
import { createExponentialBackoff } from '../retry/exponential-backoff.js';
import { createFixedBackoff } from '../retry/fixed-backoff.js';
import { cloneTask } from '../task.js';
import { createId, DEFAULT_METADATA_MAX_BYTES, nowIso, serializeMetadata } from '../utils.js';
import { FileNotFoundError } from '../../errors/file-not-found.error.js';
import { UploadNotFoundError } from '../../errors/upload-not-found.error.js';
import { ConcurrencyController } from './concurrency-controller.js';
import { QueueCoordinator } from './queue-coordinator.js';
import { UploadStateMachine } from './upload-state-machine.js';

export interface UploadQueueRecoveryOptions {
  readonly processingTimeoutMs?: number;
}

export interface UploadQueueProgressOptions {
  readonly eventThrottleMs?: number;
  readonly persistEveryPercent?: number;
  readonly persistEveryMs?: number;
}

export interface UploadQueueOptions {
  readonly storage: UploadStorage;
  readonly transport: UploadTransport;
  readonly retry?: RetryConfig;
  readonly concurrency?: number;
  readonly connectivity?: ConnectivityProvider;
  readonly fileProvider?: FileProvider;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly recovery?: UploadQueueRecoveryOptions;
  readonly progress?: UploadQueueProgressOptions;
  readonly autoProcessOnReconnect?: boolean;
  readonly metadataMaxBytes?: number;
}

export interface UploadQueue {
  initialize(): Promise<void>;
  enqueue(input: EnqueueUploadInput): Promise<UploadTask>;
  start(): Promise<void>;
  stop(): Promise<void>;
  process(): Promise<UploadProcessResult>;
  pause(uploadId: string): Promise<UploadTask>;
  resume(uploadId: string): Promise<UploadTask>;
  cancel(uploadId: string): Promise<UploadTask>;
  retry(uploadId: string): Promise<UploadTask>;
  get(uploadId: string): Promise<UploadTask | null>;
  list(): Promise<readonly UploadTask[]>;
  purgeCompleted(olderThanIso?: string): Promise<number>;
  subscribe(listener: UploadEventListener): () => void;
  destroy(): Promise<void>;
}

const DEFAULT_FILE_PROVIDER: FileProvider = {
  async exists(): Promise<boolean> {
    return true;
  },
  async getSize(): Promise<number | undefined> {
    return undefined;
  },
};

function resolveRetryStrategy(config: RetryConfig = {}): RetryStrategy {
  if (config.strategy && typeof config.strategy !== 'string') {
    return config.strategy;
  }

  if (config.strategy === 'fixed') {
    return createFixedBackoff({
      ...(config.initialDelayMs !== undefined ? { delayMs: config.initialDelayMs } : {}),
      ...(config.maxDelayMs !== undefined ? { maxDelayMs: config.maxDelayMs } : {}),
    });
  }

  return createExponentialBackoff({
    ...(config.initialDelayMs !== undefined ? { initialDelayMs: config.initialDelayMs } : {}),
    ...(config.maxDelayMs !== undefined ? { maxDelayMs: config.maxDelayMs } : {}),
    ...(config.multiplier !== undefined ? { multiplier: config.multiplier } : {}),
    ...(config.jitter !== undefined ? { jitter: config.jitter } : {}),
  });
}

function emptyResult(
  reason?: UploadProcessResult['reason'],
): UploadProcessResult {
  return {
    processed: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    deferred: 0,
    cancelled: 0,
    skipped: reason !== undefined,
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function createUploadQueue(options: UploadQueueOptions): UploadQueue {
  const storage = options.storage;
  const clock = options.clock ?? createSystemClock();
  const logger = options.logger ?? createNoopLogger();
  const fileProvider = options.fileProvider ?? DEFAULT_FILE_PROVIDER;
  const emitter = new UploadEventEmitter();
  const coordinator = new QueueCoordinator();
  const stateMachine = new UploadStateMachine();
  const concurrencyLimit = Math.max(1, options.concurrency ?? 2);
  const defaultMaxAttempts = options.retry?.maxAttempts ?? 5;
  const processingTimeoutMs = options.recovery?.processingTimeoutMs ?? 5 * 60_000;
  const autoProcessOnReconnect = options.autoProcessOnReconnect ?? true;
  const metadataMaxBytes = options.metadataMaxBytes ?? DEFAULT_METADATA_MAX_BYTES;
  const controllers = new Map<string, AbortController>();

  let initialization: Promise<void> | undefined;
  let started = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeConnectivity: (() => void) | undefined;
  let wasOffline = false;

  const getAbortSignal = (uploadId: string): AbortSignal => {
    const existing = controllers.get(uploadId);
    if (existing && !existing.signal.aborted) {
      return existing.signal;
    }

    const controller = new AbortController();
    controllers.set(uploadId, controller);
    return controller.signal;
  };

  const abortUpload = (uploadId: string): void => {
    const controller = controllers.get(uploadId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
  };

  const processor = new UploadProcessor({
    storage,
    transport: options.transport,
    retryStrategy: resolveRetryStrategy(options.retry),
    errorClassifier: new UploadErrorClassifier(),
    fileProvider,
    clock,
    logger,
    emit: (event) => emitter.emit(event),
    getAbortSignal,
    isOnline: async () => (options.connectivity ? options.connectivity.isOnline() : true),
    progressEventThrottleMs: options.progress?.eventThrottleMs ?? 200,
    persistEveryPercent: options.progress?.persistEveryPercent ?? 0.1,
    persistEveryMs: options.progress?.persistEveryMs ?? 500,
  });

  const requireTask = async (uploadId: string): Promise<UploadTask> => {
    const task = await storage.get(uploadId);
    if (!task) {
      throw new UploadNotFoundError(uploadId);
    }
    return task;
  };

  const recoverAbandoned = async (): Promise<number> => {
    const staleBefore = new Date(clock.now().getTime() - processingTimeoutMs).toISOString();
    const abandoned = await storage.getRecoverable(staleBefore);
    const updatedAt = nowIso(clock.now());
    let recovered = 0;

    for (const task of abandoned) {
      if (!stateMachine.canTransition(task.status, 'pending')) {
        continue;
      }

      await storage.update(
        cloneTask(
          task,
          {
            status: 'pending',
            updatedAt,
            progress: 0,
          },
          ['processingToken', 'processingStartedAt', 'nextAttemptAt'],
        ),
      );
      recovered += 1;
    }

    if (recovered > 0) {
      logger.info('recovered abandoned uploads', { recovered });
    }

    return recovered;
  };

  const scheduleWake = async (): Promise<void> => {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = undefined;
    }

    if (!started) {
      return;
    }

    const tasks = await storage.list();
    let earliest: number | undefined;

    for (const task of tasks) {
      if (task.status !== 'pending' || !task.nextAttemptAt) {
        continue;
      }

      const at = Date.parse(task.nextAttemptAt);
      if (Number.isNaN(at)) {
        continue;
      }

      earliest = earliest === undefined ? at : Math.min(earliest, at);
    }

    if (earliest === undefined) {
      return;
    }

    const delayMs = Math.max(0, earliest - clock.now().getTime());
    wakeTimer = setTimeout(() => {
      void queue.process().then(() => scheduleWake());
    }, delayMs);
  };

  const processPending = async (): Promise<UploadProcessResult> => {
    if (options.connectivity && !(await options.connectivity.isOnline())) {
      logger.info('upload processing skipped', { reason: 'offline' });
      return emptyResult('offline');
    }

    const concurrency = new ConcurrencyController(concurrencyLimit);
    const inFlight = new Map<string, Promise<UploadStatus>>();
    let processed = 0;
    let completed = 0;
    let failed = 0;
    let blocked = 0;
    let deferred = 0;
    let cancelled = 0;

    const record = (status: UploadStatus): void => {
      processed += 1;
      if (status === 'completed') {
        completed += 1;
      } else if (status === 'failed') {
        failed += 1;
      } else if (status === 'blocked') {
        blocked += 1;
      } else if (status === 'cancelled') {
        cancelled += 1;
      } else {
        deferred += 1;
      }
    };

    const launch = (task: UploadTask): void => {
      if (!concurrency.tryAcquire()) {
        return;
      }

      const promise = processor
        .process(task)
        .then((status) => {
          record(status);
          return status;
        })
        .finally(() => {
          concurrency.release();
          inFlight.delete(task.id);
          controllers.delete(task.id);
        });

      inFlight.set(task.id, promise);
    };

    for (;;) {
      if (options.connectivity && !(await options.connectivity.isOnline())) {
        break;
      }

      while (concurrency.remaining > 0) {
        const pending = await storage.getPending(concurrency.remaining, nowIso(clock.now()));
        const next = pending.filter((task) => !inFlight.has(task.id));
        if (next.length === 0) {
          break;
        }

        for (const task of next) {
          launch(task);
        }
      }

      if (inFlight.size === 0) {
        break;
      }

      await Promise.race(inFlight.values());
    }

    await Promise.all(inFlight.values());

    return {
      processed,
      completed,
      failed,
      blocked,
      deferred,
      cancelled,
      skipped: false,
    };
  };

  const queue: UploadQueue = {
    async initialize(): Promise<void> {
      initialization ??= (async () => {
        try {
          await storage.initialize();
          await recoverAbandoned();

          if (options.connectivity) {
            wasOffline = !(await options.connectivity.isOnline());
            unsubscribeConnectivity = options.connectivity.subscribe((isOnline) => {
              const shouldProcess = isOnline && wasOffline && autoProcessOnReconnect && started;
              wasOffline = !isOnline;

              if (!shouldProcess) {
                return;
              }

              void queue.process().catch((error: unknown) => {
                logger.error('automatic process after reconnect failed', {
                  message: error instanceof Error ? error.message : 'unknown',
                });
              });
            });
          }
        } catch (error) {
          initialization = undefined;
          throw error;
        }
      })();

      return initialization;
    },

    async enqueue(input: EnqueueUploadInput): Promise<UploadTask> {
      await queue.initialize();
      serializeMetadata(input.metadata, metadataMaxBytes);

      const createdAt = nowIso(clock.now());
      const task: UploadTask = cloneTask(
        {
          id: createId(),
          fileUri: input.fileUri,
          fileName: input.fileName,
          destination: input.destination,
          method: input.method ?? 'POST',
          status: 'pending',
          attempts: 0,
          maxAttempts: input.maxAttempts ?? defaultMaxAttempts,
          idempotencyKey: input.idempotencyKey ?? createId(),
          progress: 0,
          createdAt,
          updatedAt: createdAt,
        },
        {
          ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
          ...(input.size !== undefined ? { size: input.size } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        },
      );

      await storage.insert(task);
      logger.info('upload queued', { uploadId: task.id });
      emitter.emit({
        type: 'upload.queued',
        uploadId: task.id,
        status: task.status,
      });

      if (started) {
        void queue.process().then(() => scheduleWake());
      }

      return task;
    },

    async start(): Promise<void> {
      await queue.initialize();
      started = true;
      await queue.process();
      await scheduleWake();
    },

    async stop(): Promise<void> {
      started = false;
      if (wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
    },

    async process(): Promise<UploadProcessResult> {
      await queue.initialize();

      const exclusive = await coordinator.runExclusive(processPending);
      if (!exclusive.ran) {
        return emptyResult('busy');
      }

      return exclusive.result;
    },

    async pause(uploadId: string): Promise<UploadTask> {
      await queue.initialize();
      const task = await requireTask(uploadId);

      if (task.status === 'paused') {
        return task;
      }

      stateMachine.assertCanTransition(task.status, 'paused', uploadId);
      const updated = cloneTask(
        task,
        {
          status: 'paused',
          updatedAt: nowIso(clock.now()),
        },
        ['processingToken', 'processingStartedAt', 'nextAttemptAt'],
      );
      await storage.update(updated);
      abortUpload(uploadId);
      emitter.emit({ type: 'upload.paused', uploadId });
      return updated;
    },

    async resume(uploadId: string): Promise<UploadTask> {
      await queue.initialize();
      const task = await requireTask(uploadId);

      if (task.status === 'pending') {
        return task;
      }

      stateMachine.assertCanTransition(task.status, 'pending', uploadId);
      const updated = cloneTask(
        task,
        {
          status: 'pending',
          updatedAt: nowIso(clock.now()),
        },
        ['processingToken', 'processingStartedAt', 'nextAttemptAt'],
      );
      await storage.update(updated);

      if (started) {
        void queue.process().then(() => scheduleWake());
      }

      return updated;
    },

    async cancel(uploadId: string): Promise<UploadTask> {
      await queue.initialize();
      const task = await requireTask(uploadId);

      if (task.status === 'cancelled') {
        return task;
      }

      stateMachine.assertCanTransition(task.status, 'cancelled', uploadId);
      const updated = cloneTask(
        task,
        {
          status: 'cancelled',
          updatedAt: nowIso(clock.now()),
        },
        ['processingToken', 'processingStartedAt', 'nextAttemptAt'],
      );
      await storage.update(updated);
      abortUpload(uploadId);
      emitter.emit({ type: 'upload.cancelled', uploadId });
      return updated;
    },

    async retry(uploadId: string): Promise<UploadTask> {
      await queue.initialize();
      const task = await requireTask(uploadId);
      stateMachine.assertCanTransition(task.status, 'pending', uploadId);

      const exists = await fileProvider.exists(task.fileUri);
      if (!exists) {
        throw new FileNotFoundError(task.fileUri);
      }

      const updated = cloneTask(
        task,
        {
          status: 'pending',
          attempts: 0,
          progress: 0,
          updatedAt: nowIso(clock.now()),
        },
        ['processingToken', 'processingStartedAt', 'nextAttemptAt', 'lastError'],
      );
      await storage.update(updated);

      if (started) {
        void queue.process().then(() => scheduleWake());
      }

      return updated;
    },

    async get(uploadId: string): Promise<UploadTask | null> {
      await queue.initialize();
      return storage.get(uploadId);
    },

    async list(): Promise<readonly UploadTask[]> {
      await queue.initialize();
      return storage.list();
    },

    async purgeCompleted(olderThanIso?: string): Promise<number> {
      await queue.initialize();
      return storage.deleteCompleted(olderThanIso);
    },

    subscribe(listener: UploadEventListener): () => void {
      return emitter.subscribe(listener);
    },

    async destroy(): Promise<void> {
      await queue.stop();
      unsubscribeConnectivity?.();
      unsubscribeConnectivity = undefined;
      emitter.clear();
      const wasInitialized = initialization !== undefined;
      initialization = undefined;
      if (wasInitialized) {
        await storage.close?.();
      }
    },
  };

  return queue;
}
