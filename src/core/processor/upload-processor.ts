import type { Clock } from '../contracts/clock.js';
import type { FileProvider } from '../contracts/file-provider.js';
import type { Logger } from '../contracts/logger.js';
import type { RetryStrategy } from '../contracts/retry-strategy.js';
import type { UploadStorage } from '../contracts/upload-storage.js';
import type { UploadTransport } from '../contracts/upload-transport.js';
import type { UploadQueueEvent } from '../models/upload-event.js';
import type { UploadError } from '../models/upload-error.js';
import type { UploadStatus } from '../models/upload-status.js';
import type { UploadTask } from '../models/upload-task.js';
import { FileNotFoundError } from '../../errors/file-not-found.error.js';
import { cloneTask } from '../task.js';
import { clampProgress, createId, isAbortError, nowIso } from '../utils.js';
import { type UploadErrorClassifier, toUploadError } from './upload-error-classifier.js';

export interface UploadAttemptOutcome {
  /** False when the claim was lost or the upload was not eligible after all. */
  readonly claimed: boolean;
  readonly status: UploadStatus;
}

export interface UploadProcessorOptions {
  readonly storage: UploadStorage;
  readonly transport: UploadTransport;
  readonly retryStrategy: RetryStrategy;
  readonly errorClassifier: UploadErrorClassifier;
  readonly fileProvider: FileProvider;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly emit: (event: UploadQueueEvent) => void;
  readonly getAbortSignal: (uploadId: string) => AbortSignal;
  readonly isOnline: () => Promise<boolean>;
  readonly isShuttingDown: () => boolean;
  readonly progressEventThrottleMs: number;
  readonly persistEveryPercent: number;
  readonly persistEveryMs: number;
}

export class UploadProcessor {
  private readonly storage: UploadStorage;
  private readonly transport: UploadTransport;
  private readonly retryStrategy: RetryStrategy;
  private readonly errorClassifier: UploadErrorClassifier;
  private readonly fileProvider: FileProvider;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly emit: (event: UploadQueueEvent) => void;
  private readonly getAbortSignal: (uploadId: string) => AbortSignal;
  private readonly isOnline: () => Promise<boolean>;
  private readonly isShuttingDown: () => boolean;
  private readonly progressEventThrottleMs: number;
  private readonly persistEveryPercent: number;
  private readonly persistEveryMs: number;

  constructor(options: UploadProcessorOptions) {
    this.storage = options.storage;
    this.transport = options.transport;
    this.retryStrategy = options.retryStrategy;
    this.errorClassifier = options.errorClassifier;
    this.fileProvider = options.fileProvider;
    this.clock = options.clock;
    this.logger = options.logger;
    this.emit = options.emit;
    this.getAbortSignal = options.getAbortSignal;
    this.isOnline = options.isOnline;
    this.isShuttingDown = options.isShuttingDown;
    this.progressEventThrottleMs = options.progressEventThrottleMs;
    this.persistEveryPercent = options.persistEveryPercent;
    this.persistEveryMs = options.persistEveryMs;
  }

  /**
   * Runs one attempt. `claimed` is false when the upload was taken by someone
   * else or was no longer eligible, which lets the caller keep it out of the
   * processed counts instead of reporting work it never did.
   */
  async process(task: UploadTask): Promise<UploadAttemptOutcome> {
    const token = createId();
    const claimed = await this.storage.claim(task.id, token, nowIso(this.clock.now()));
    if (!claimed) {
      const current = await this.storage.get(task.id);
      return { claimed: false, status: current?.status ?? task.status };
    }

    this.emit({
      type: 'upload.started',
      uploadId: claimed.id,
      attempts: claimed.attempts + 1,
    });

    try {
      return { claimed: true, status: await this.runClaimed(claimed, token) };
    } catch (error) {
      return {
        claimed: true,
        status: await this.releaseClaim(
          claimed,
          token,
          toUploadError(error, nowIso(this.clock.now())),
        ),
      };
    }
  }

  /**
   * Persists `next` only while we still hold the claim. If the row changed
   * hands — the user paused or cancelled it, or recovery handed it to another
   * worker — the write is dropped and the caller reports the state that
   * actually won, rather than resurrecting a stale pre-upload snapshot.
   */
  private async commit(
    next: UploadTask,
    token: string,
  ): Promise<{ committed: boolean; status: UploadStatus }> {
    const committed = await this.storage.updateOwned(next, token);
    if (committed) {
      return { committed: true, status: next.status };
    }

    const current = await this.storage.get(next.id);
    this.logger.info('upload write skipped, claim no longer held', {
      uploadId: next.id,
      attempted: next.status,
      actual: current?.status ?? 'missing',
    });
    return { committed: false, status: current?.status ?? next.status };
  }

  private async runClaimed(claimed: UploadTask, token: string): Promise<UploadStatus> {
    if (!(await this.isOnline())) {
      return this.releaseOffline(claimed, token);
    }

    const exists = await this.fileProvider.exists(claimed.fileUri);
    if (!exists) {
      return this.fail(
        claimed,
        token,
        new FileNotFoundError(claimed.fileUri).toUploadError(nowIso(this.clock.now())),
      );
    }

    const size = claimed.size ?? (await this.fileProvider.getSize(claimed.fileUri));
    const withSize =
      size !== undefined && claimed.size === undefined ? cloneTask(claimed, { size }) : claimed;

    let persistChain = Promise.resolve();
    let lastEventAt = 0;
    let lastPersistedProgress = 0;
    let lastPersistedAt = 0;

    const persistProgress = (
      bytesUploaded: number,
      progress: number,
      totalBytes: number | undefined,
    ): void => {
      persistChain = persistChain.then(async () => {
        // Four columns, fenced on the claim token. The token is what makes this
        // safe: if the upload was paused, cancelled or recovered mid-flight the
        // row no longer carries it and the write is a no-op.
        await this.storage.updateProgress({
          id: withSize.id,
          processingToken: token,
          progress,
          bytesUploaded,
          updatedAt: nowIso(this.clock.now()),
          ...(totalBytes !== undefined ? { totalBytes } : {}),
        });
      });
    };

    const onProgress = (bytesUploaded: number, totalBytes?: number): void => {
      const total = totalBytes ?? withSize.totalBytes ?? withSize.size;
      const progress = total && total > 0 ? clampProgress(bytesUploaded / total) : 0;
      const nowMs = this.clock.now().getTime();

      if (nowMs - lastEventAt >= this.progressEventThrottleMs) {
        lastEventAt = nowMs;
        this.emit({
          type: 'upload.progress',
          uploadId: withSize.id,
          progress,
          bytesUploaded,
          ...(total !== undefined ? { totalBytes: total } : {}),
        });
      }

      const percentJump = progress - lastPersistedProgress >= this.persistEveryPercent;
      const timeJump = nowMs - lastPersistedAt >= this.persistEveryMs;
      if (percentJump || timeJump) {
        lastPersistedProgress = progress;
        lastPersistedAt = nowMs;
        persistProgress(bytesUploaded, progress, total);
      }
    };

    try {
      const result = await this.transport.upload(withSize, {
        signal: this.getAbortSignal(withSize.id),
        onProgress,
      });
      await persistChain;

      if (result.statusCode >= 200 && result.statusCode < 300) {
        return this.complete(withSize, token, result.remoteId, result.response);
      }

      return this.handleFailure(
        withSize,
        token,
        this.errorClassifier.classifyHttp(
          result.statusCode,
          nowIso(this.clock.now()),
          result.retryAfterMs,
        ),
      );
    } catch (error) {
      await persistChain;

      if (isAbortError(error)) {
        const current = await this.storage.get(withSize.id);
        if (current?.status === 'paused' || current?.status === 'cancelled') {
          return current.status;
        }
      }

      return this.handleFailure(
        withSize,
        token,
        this.errorClassifier.classifyUnknown(error, nowIso(this.clock.now())),
      );
    }
  }

  private async complete(
    task: UploadTask,
    token: string,
    remoteId: string | undefined,
    response: unknown,
  ): Promise<UploadStatus> {
    const completedAt = nowIso(this.clock.now());
    const persisted = cloneTask(
      task,
      {
        status: 'completed',
        attempts: task.attempts + 1,
        progress: 1,
        updatedAt: completedAt,
        completedAt,
        ...(remoteId !== undefined ? { remoteId } : {}),
      },
      ['processingToken', 'processingStartedAt', 'nextAttemptAt', 'lastError'],
    );

    const { committed, status } = await this.commit(persisted, token);
    if (!committed) {
      return status;
    }

    this.logger.info('upload completed', { uploadId: task.id, attempts: persisted.attempts });
    this.emit({
      type: 'upload.completed',
      uploadId: task.id,
      attempts: persisted.attempts,
      ...(remoteId !== undefined ? { remoteId } : {}),
      ...(response !== undefined ? { response } : {}),
    });
    return 'completed';
  }

  private async handleFailure(
    task: UploadTask,
    token: string,
    error: UploadError,
  ): Promise<UploadStatus> {
    const attempts = task.attempts + 1;
    const updatedAt = nowIso(this.clock.now());

    // Both 401 and 403 need a human: a new token, or new permissions. Retrying
    // on the current credentials cannot fix either, so they park in `blocked`
    // rather than burning attempts down to `failed`.
    if (error.kind === 'authentication' || error.kind === 'authorization') {
      const blocked = cloneTask(
        task,
        {
          status: 'blocked',
          attempts,
          updatedAt,
          lastError: error,
          progress: 0,
        },
        ['processingToken', 'processingStartedAt', 'nextAttemptAt'],
      );
      const outcome = await this.commit(blocked, token);
      if (!outcome.committed) {
        return outcome.status;
      }

      this.logger.warn('upload blocked', { uploadId: task.id, attempts });
      this.emit({
        type: 'upload.blocked',
        uploadId: task.id,
        error,
        attempts,
      });
      return 'blocked';
    }

    if (error.kind === 'cancelled') {
      const current = await this.storage.get(task.id);
      if (current?.status === 'paused' || current?.status === 'cancelled') {
        return current.status;
      }

      // Aborted because the queue is shutting down, not because the user acted:
      // hand the upload straight back to the pool instead of burning an attempt.
      if (this.isShuttingDown()) {
        return this.releaseClaim(task, token, error);
      }
    }

    const retryable = error.retryable && attempts < task.maxAttempts;
    if (!retryable) {
      return this.fail(task, token, error, attempts);
    }

    const delayMs = error.retryAfterMs ?? this.retryStrategy.nextDelayMs(attempts);
    const nextAttemptAt = new Date(this.clock.now().getTime() + delayMs).toISOString();
    const pending = cloneTask(
      task,
      {
        status: 'pending',
        attempts,
        updatedAt,
        lastError: error,
        nextAttemptAt,
        progress: 0,
      },
      ['processingToken', 'processingStartedAt'],
    );

    const outcome = await this.commit(pending, token);
    if (!outcome.committed) {
      return outcome.status;
    }

    this.logger.info('upload retry scheduled', { uploadId: task.id, attempts, delayMs });
    this.emit({
      type: 'upload.retry_scheduled',
      uploadId: task.id,
      attempts,
      nextAttemptAt,
      delayMs,
      error,
    });
    return 'pending';
  }

  private async fail(
    task: UploadTask,
    token: string,
    error: UploadError,
    attempts = task.attempts + 1,
  ): Promise<UploadStatus> {
    const updatedAt = nowIso(this.clock.now());
    const failed = cloneTask(
      task,
      {
        status: 'failed',
        attempts,
        updatedAt,
        lastError: error,
        progress: 0,
      },
      ['processingToken', 'processingStartedAt', 'nextAttemptAt'],
    );

    const outcome = await this.commit(failed, token);
    if (!outcome.committed) {
      return outcome.status;
    }

    this.logger.warn('upload failed', { uploadId: task.id, attempts });
    this.emit({
      type: 'upload.failed',
      uploadId: task.id,
      error,
      attempts,
    });
    return 'failed';
  }

  private async releaseOffline(task: UploadTask, token: string): Promise<UploadStatus> {
    const updatedAt = nowIso(this.clock.now());
    const pending = cloneTask(
      task,
      {
        status: 'pending',
        updatedAt,
      },
      ['processingToken', 'processingStartedAt', 'nextAttemptAt'],
    );

    const { committed, status } = await this.commit(pending, token);
    if (!committed) {
      return status;
    }

    this.logger.info('upload deferred offline', { uploadId: task.id });
    return 'pending';
  }

  private async releaseClaim(
    task: UploadTask,
    token: string,
    error: UploadError,
  ): Promise<UploadStatus> {
    try {
      const updatedAt = nowIso(this.clock.now());
      const released = cloneTask(
        task,
        {
          status: 'pending',
          updatedAt,
          lastError: error,
        },
        ['processingToken', 'processingStartedAt'],
      );

      const { committed, status } = await this.commit(released, token);
      if (!committed) {
        return status;
      }
    } catch {
      this.logger.error('failed to release upload claim', { uploadId: task.id });
    }

    return 'pending';
  }
}
