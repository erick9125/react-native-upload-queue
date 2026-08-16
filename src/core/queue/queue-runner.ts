import type { Clock } from '../contracts/clock.js';
import type { Logger } from '../contracts/logger.js';
import type { UploadStorage } from '../contracts/upload-storage.js';
import type { UploadProcessResult } from '../models/upload-result.js';
import type { UploadStatus } from '../models/upload-status.js';
import type { UploadTask } from '../models/upload-task.js';
import type { UploadProcessor } from '../processor/upload-processor.js';
import { nowIso } from '../utils.js';
import { ConcurrencyController } from './concurrency-controller.js';

export interface QueueRunnerOptions {
  readonly storage: UploadStorage;
  readonly processor: UploadProcessor;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyLimit: number;
  readonly isOnline: () => Promise<boolean>;
  readonly isShuttingDown: () => boolean;
  /** Reads and clears the "work arrived while you were busy" flag. */
  readonly consumeRerunRequest: () => boolean;
  /** Called once an upload leaves the batch, so the caller can drop its abort controller. */
  readonly onSettled: (uploadId: string) => void;
}

function emptyCounters(): {
  processed: number;
  completed: number;
  failed: number;
  blocked: number;
  deferred: number;
  cancelled: number;
  errored: number;
} {
  return {
    processed: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    deferred: 0,
    cancelled: 0,
    errored: 0,
  };
}

/**
 * Drains pending uploads up to the concurrency limit.
 *
 * Two invariants hold the loop together: no upload is attempted more than once
 * per pass, and no single upload's failure can escape and abort the pass.
 */
export class QueueRunner {
  private batch: Map<string, Promise<UploadStatus>> | undefined;

  constructor(private readonly options: QueueRunnerOptions) {}

  /** Awaits whatever is currently in flight. Used by shutdown, which aborts first. */
  async drain(): Promise<void> {
    const batch = this.batch;
    if (batch && batch.size > 0) {
      await Promise.allSettled([...batch.values()]);
    }
  }

  async run(): Promise<UploadProcessResult> {
    const { storage, processor, clock, logger, isOnline, isShuttingDown, onSettled } = this.options;

    if (!(await isOnline())) {
      logger.info('upload processing skipped', { reason: 'offline' });
      return {
        ...emptyCounters(),
        skipped: true,
        reason: 'offline',
      };
    }

    const concurrency = new ConcurrencyController(this.options.concurrencyLimit);
    const inFlight = new Map<string, Promise<UploadStatus>>();
    /**
     * Uploads this pass already attempted that landed back on `pending` — a
     * failed claim, a storage fault, a deferred attempt. They are pending in
     * storage again, so without excluding them getPending() hands them straight
     * back and the loop spins on the same upload forever.
     */
    const stalled = new Set<string>();
    const counters = emptyCounters();

    this.batch = inFlight;
    this.options.consumeRerunRequest();

    const record = (status: UploadStatus): void => {
      counters.processed += 1;
      if (status === 'completed') {
        counters.completed += 1;
      } else if (status === 'failed') {
        counters.failed += 1;
      } else if (status === 'blocked') {
        counters.blocked += 1;
      } else if (status === 'cancelled') {
        counters.cancelled += 1;
      } else {
        counters.deferred += 1;
      }
    };

    const launch = (task: UploadTask): void => {
      if (!concurrency.tryAcquire()) {
        return;
      }

      // Settled, never rejected: a single upload blowing up (a storage fault in
      // claim(), say) must not abort the drain and orphan its siblings.
      const promise = processor
        .process(task)
        .then(
          ({ claimed, status }): UploadStatus => {
            // An upload someone else claimed was not processed by us; counting
            // it would inflate the result the caller uses as a metric.
            if (claimed) {
              record(status);
            }
            if (status === 'pending') {
              stalled.add(task.id);
            }
            return status;
          },
          (error: unknown): UploadStatus => {
            counters.errored += 1;
            stalled.add(task.id);
            logger.error('upload processing threw', {
              uploadId: task.id,
              message: error instanceof Error ? error.message : 'unknown',
            });
            return 'pending';
          },
        )
        .finally(() => {
          concurrency.release();
          inFlight.delete(task.id);
          onSettled(task.id);
        });

      inFlight.set(task.id, promise);
    };

    try {
      for (;;) {
        if (isShuttingDown()) {
          break;
        }

        if (!(await isOnline())) {
          break;
        }

        while (concurrency.remaining > 0) {
          // Over-fetch by the stalled count: those rows are pending again and
          // sit at the head of the queue, so a bare LIMIT would spend the whole
          // budget on them and starve the uploads waiting behind.
          const pending = await storage.getPending(
            concurrency.remaining + stalled.size,
            nowIso(clock.now()),
          );
          const next = pending
            .filter((task) => !inFlight.has(task.id) && !stalled.has(task.id))
            .slice(0, concurrency.remaining);

          if (next.length === 0) {
            break;
          }

          for (const task of next) {
            launch(task);
          }
        }

        if (inFlight.size === 0) {
          if (this.options.consumeRerunRequest()) {
            continue;
          }
          break;
        }

        await Promise.race(inFlight.values());
      }

      await Promise.all(inFlight.values());
    } finally {
      if (this.batch === inFlight) {
        this.batch = undefined;
      }
    }

    return { ...counters, skipped: false };
  }
}
