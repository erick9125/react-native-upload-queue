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
import type { UploadProcessResult, UploadSkipReason } from '../models/upload-result.js';
import type { EnqueueUploadInput, UploadTask } from '../models/upload-task.js';
import { UploadErrorClassifier } from '../processor/upload-error-classifier.js';
import { UploadProcessor } from '../processor/upload-processor.js';
import { createExponentialBackoff } from '../retry/exponential-backoff.js';
import { createFixedBackoff } from '../retry/fixed-backoff.js';
import { cloneTask } from '../task.js';
import { createId, DEFAULT_METADATA_MAX_BYTES, nowIso, serializeMetadata } from '../utils.js';
import { FileNotFoundError } from '../../errors/file-not-found.error.js';
import { UploadNotFoundError } from '../../errors/upload-not-found.error.js';
import { QueueCoordinator } from './queue-coordinator.js';
import { QueueRunner } from './queue-runner.js';
import { UploadStateMachine } from './upload-state-machine.js';
import { WakeScheduler } from './wake-scheduler.js';

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

function skippedResult(reason: UploadSkipReason): UploadProcessResult {
  return {
    processed: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    deferred: 0,
    cancelled: 0,
    errored: 0,
    skipped: true,
    reason,
  };
}

function mergeResults(left: UploadProcessResult, right: UploadProcessResult): UploadProcessResult {
  return {
    processed: left.processed + right.processed,
    completed: left.completed + right.completed,
    failed: left.failed + right.failed,
    blocked: left.blocked + right.blocked,
    deferred: left.deferred + right.deferred,
    cancelled: left.cancelled + right.cancelled,
    errored: left.errored + right.errored,
    skipped: left.skipped && right.skipped,
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
  let shuttingDown = false;
  let unsubscribeConnectivity: (() => void) | undefined;
  let wasOffline = false;
  /**
   * Set when a process() call arrives while a drain is already running. Work
   * enqueued in that window is invisible to the running pass if it happens to be
   * past its last getPending(), and a freshly enqueued upload has no
   * nextAttemptAt for the wake timer to fire on — so it would sit untouched
   * until the next external trigger. The running pass consumes this flag and
   * takes another lap instead.
   */
  let rerunRequested = false;

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

  const abortAll = (): void => {
    for (const controller of controllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
  };

  /**
   * Fire-and-forget processing that can never surface as an unhandled rejection.
   * Every background trigger (enqueue, resume, retry, wake timer, reconnect)
   * goes through here; a rejected process() must not take the app down.
   */
  const triggerProcess = (): void => {
    void queue
      .process()
      .then(() => scheduleWake())
      .catch((error: unknown) => {
        logger.error('background processing failed', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
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
    isShuttingDown: () => shuttingDown,
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
    // `uploading -> pending` is always a legal transition, so this needs no
    // per-row state check and collapses into a single statement.
    const recovered = await storage.recoverAbandoned(staleBefore, nowIso(clock.now()));

    if (recovered > 0) {
      logger.info('recovered abandoned uploads', { recovered });
    }

    return recovered;
  };

  const scheduler = new WakeScheduler({
    clock,
    getEarliestNextAttemptAt: () => storage.getEarliestNextAttemptAt(),
    onWake: () => triggerProcess(),
  });

  const scheduleWake = async (): Promise<void> => {
    if (!started) {
      scheduler.cancel();
      return;
    }

    await scheduler.schedule();
  };

  const runner = new QueueRunner({
    storage,
    processor,
    clock,
    logger,
    concurrencyLimit,
    isOnline: async () => (options.connectivity ? options.connectivity.isOnline() : true),
    isShuttingDown: () => shuttingDown,
    consumeRerunRequest: () => {
      const requested = rerunRequested;
      rerunRequested = false;
      return requested;
    },
    onSettled: (uploadId: string) => {
      controllers.delete(uploadId);
    },
  });

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

              triggerProcess();
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
      // Validates size and JSON-serializability once, and the result doubles as
      // the defensive copy instead of a second stringify/parse round trip.
      const serializedMetadata = serializeMetadata(input.metadata, metadataMaxBytes);

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
          ...(serializedMetadata !== undefined
            ? { metadata: JSON.parse(serializedMetadata) as Record<string, unknown> }
            : {}),
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
        triggerProcess();
      }

      return task;
    },

    async start(): Promise<void> {
      await queue.initialize();
      started = true;
      await queue.process();
      await scheduleWake();
    },

    /**
     * Aborts every in-flight attempt and waits for the batch to unwind before
     * returning, so callers can safely tear down storage afterwards. Uploads
     * interrupted this way go back to `pending` without burning an attempt.
     */
    async stop(): Promise<void> {
      started = false;
      scheduler.cancel();

      shuttingDown = true;
      try {
        abortAll();
        await runner.drain();
      } finally {
        shuttingDown = false;
        controllers.clear();
      }
    },

    async process(): Promise<UploadProcessResult> {
      await queue.initialize();

      let aggregate: UploadProcessResult | undefined;
      for (;;) {
        const exclusive = await coordinator.runExclusive(() => runner.run());
        if (!exclusive.ran) {
          // Another pass owns the queue. Ask it to take one more lap so the work
          // we were called for is not left behind, and report busy.
          rerunRequested = true;
          return aggregate ?? skippedResult('busy');
        }

        aggregate = aggregate ? mergeResults(aggregate, exclusive.result) : exclusive.result;

        // Set in the gap between the drain finishing and the lock being released,
        // which the in-loop check above cannot see.
        if (!rerunRequested) {
          return aggregate;
        }
      }
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
        triggerProcess();
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
        triggerProcess();
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
