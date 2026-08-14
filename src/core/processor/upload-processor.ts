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
    this.progressEventThrottleMs = options.progressEventThrottleMs;
    this.persistEveryPercent = options.persistEveryPercent;
    this.persistEveryMs = options.persistEveryMs;
  }

  async process(task: UploadTask): Promise<UploadStatus> {
    const claimed = await this.storage.claim(
      task.id,
      createId(),
      nowIso(this.clock.now()),
    );
    if (!claimed) {
      return task.status;
    }

    this.emit({
      type: 'upload.started',
      uploadId: claimed.id,
      attempts: claimed.attempts + 1,
    });

    try {
      return await this.runClaimed(claimed);
    } catch (error) {
      return this.releaseClaim(claimed, toUploadError(error, nowIso(this.clock.now())));
    }
  }

  private async runClaimed(claimed: UploadTask): Promise<UploadStatus> {
    if (!(await this.isOnline())) {
      return this.releaseOffline(claimed);
    }

    const exists = await this.fileProvider.exists(claimed.fileUri);
    if (!exists) {
      return this.fail(claimed, new FileNotFoundError(claimed.fileUri).toUploadError(nowIso(this.clock.now())));
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
        const current = await this.storage.get(withSize.id);
        if (!current || current.status !== 'uploading') {
          return;
        }

        await this.storage.update(
          cloneTask(current, {
            progress,
            bytesUploaded,
            updatedAt: nowIso(this.clock.now()),
            ...(totalBytes !== undefined ? { totalBytes } : {}),
          }),
        );
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
        return this.complete(withSize, result.remoteId, result.response);
      }

      return this.handleFailure(
        withSize,
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
        this.errorClassifier.classifyUnknown(error, nowIso(this.clock.now())),
      );
    }
  }

  private async complete(
    task: UploadTask,
    remoteId: string | undefined,
    _response: unknown,
  ): Promise<UploadStatus> {
    void _response;
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

    await this.storage.update(persisted);
    this.logger.info('upload completed', { uploadId: task.id, attempts: persisted.attempts });
    this.emit({
      type: 'upload.completed',
      uploadId: task.id,
      attempts: persisted.attempts,
      ...(remoteId !== undefined ? { remoteId } : {}),
    });
    return 'completed';
  }

  private async handleFailure(task: UploadTask, error: UploadError): Promise<UploadStatus> {
    const attempts = task.attempts + 1;
    const updatedAt = nowIso(this.clock.now());

    if (error.kind === 'authentication') {
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
      await this.storage.update(blocked);
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
    }

    const retryable = error.retryable && attempts < task.maxAttempts;
    if (!retryable) {
      return this.fail(task, error, attempts);
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

    await this.storage.update(pending);
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
    await this.storage.update(failed);
    this.logger.warn('upload failed', { uploadId: task.id, attempts });
    this.emit({
      type: 'upload.failed',
      uploadId: task.id,
      error,
      attempts,
    });
    return 'failed';
  }

  private async releaseOffline(task: UploadTask): Promise<UploadStatus> {
    const updatedAt = nowIso(this.clock.now());
    const pending = cloneTask(
      task,
      {
        status: 'pending',
        updatedAt,
      },
      ['processingToken', 'processingStartedAt', 'nextAttemptAt'],
    );
    await this.storage.update(pending);
    this.logger.info('upload deferred offline', { uploadId: task.id });
    return 'pending';
  }

  private async releaseClaim(task: UploadTask, error: UploadError): Promise<UploadStatus> {
    try {
      const updatedAt = nowIso(this.clock.now());
      await this.storage.update(
        cloneTask(
          task,
          {
            status: 'pending',
            updatedAt,
            lastError: error,
          },
          ['processingToken', 'processingStartedAt'],
        ),
      );
    } catch {
      this.logger.error('failed to release upload claim', { uploadId: task.id });
    }

    return 'pending';
  }
}
