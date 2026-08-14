export type { UploadStorage } from './core/contracts/upload-storage.js';
export type {
  UploadTransport,
  UploadTransportContext,
  UploadTransportResult,
} from './core/contracts/upload-transport.js';
export type {
  ConnectivityProvider,
  ConnectivityListener,
} from './core/contracts/connectivity-provider.js';
export type { RetryConfig, RetryStrategy, RetryStrategyName } from './core/contracts/retry-strategy.js';
export type { FileProvider } from './core/contracts/file-provider.js';
export type { Clock } from './core/contracts/clock.js';
export type { Logger } from './core/contracts/logger.js';

export type { UploadStatus } from './core/models/upload-status.js';
export type { UploadError, UploadErrorKind } from './core/models/upload-error.js';
export type { EnqueueUploadInput, UploadHttpMethod, UploadTask } from './core/models/upload-task.js';
export type {
  UploadBlockedEvent,
  UploadCancelledEvent,
  UploadCompletedEvent,
  UploadFailedEvent,
  UploadPausedEvent,
  UploadProgressEvent,
  UploadQueueEvent,
  UploadQueuedEvent,
  UploadRetryScheduledEvent,
  UploadStartedEvent,
} from './core/models/upload-event.js';
export type { UploadProcessResult, UploadSkipReason } from './core/models/upload-result.js';

export {
  createUploadQueue,
  type UploadQueue,
  type UploadQueueOptions,
  type UploadQueueProgressOptions,
  type UploadQueueRecoveryOptions,
} from './core/queue/upload-queue.js';
export { UploadStateMachine } from './core/queue/upload-state-machine.js';

export {
  createExponentialBackoff,
  ExponentialBackoffStrategy,
  type ExponentialBackoffOptions,
} from './core/retry/exponential-backoff.js';
export {
  createFixedBackoff,
  FixedBackoffStrategy,
  type FixedBackoffOptions,
} from './core/retry/fixed-backoff.js';

export { UploadErrorClassifier } from './core/processor/upload-error-classifier.js';
export { createSystemClock } from './core/contracts/clock.js';
export { createNoopLogger } from './core/contracts/logger.js';
export { createId } from './core/utils.js';

export {
  FileNotFoundError,
  InvalidUploadStateError,
  UploadNotFoundError,
  UploadQueueError,
  classifyHttpStatus,
  createUploadError,
  toUploadError,
} from './errors/index.js';

export { createMemoryFileProvider, createMemoryUploadStorage } from './adapters/memory/index.js';
export {
  createSQLiteUploadStorage,
  type SQLiteDriver,
  type SQLiteQueryResult,
  type SQLiteUploadStorageOptions,
} from './adapters/sqlite/index.js';
export {
  appendUploadFile,
  buildMultipartFilePart,
  createHttpUploadTransport,
  type FetchLike,
  type FetchLikeHeaders,
  type HttpUploadTransportOptions,
} from './adapters/http/index.js';
export {
  createManualConnectivity,
  createNetInfoConnectivityProvider,
  type NetInfoConnectivityOptions,
  type NetInfoLike,
  type NetInfoLikeState,
} from './adapters/netinfo/index.js';
