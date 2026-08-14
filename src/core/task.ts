import type { UploadTask } from './models/upload-task.js';
import { cloneJson } from './utils.js';

type OptionalTaskKey =
  | 'mimeType'
  | 'size'
  | 'bytesUploaded'
  | 'totalBytes'
  | 'nextAttemptAt'
  | 'startedAt'
  | 'completedAt'
  | 'lastError'
  | 'metadata'
  | 'processingToken'
  | 'processingStartedAt'
  | 'remoteId';

export function cloneTask(
  task: UploadTask,
  changes: Partial<UploadTask> = {},
  remove: readonly OptionalTaskKey[] = [],
): UploadTask {
  const omitted = new Set<OptionalTaskKey>(remove);

  const next: UploadTask = {
    id: changes.id ?? task.id,
    fileUri: changes.fileUri ?? task.fileUri,
    fileName: changes.fileName ?? task.fileName,
    destination: changes.destination ?? task.destination,
    method: changes.method ?? task.method,
    status: changes.status ?? task.status,
    attempts: changes.attempts ?? task.attempts,
    maxAttempts: changes.maxAttempts ?? task.maxAttempts,
    idempotencyKey: changes.idempotencyKey ?? task.idempotencyKey,
    progress: changes.progress ?? task.progress,
    createdAt: changes.createdAt ?? task.createdAt,
    updatedAt: changes.updatedAt ?? task.updatedAt,
  };

  const mimeType = omitted.has('mimeType') ? undefined : (changes.mimeType ?? task.mimeType);
  const size = omitted.has('size') ? undefined : (changes.size ?? task.size);
  const bytesUploaded = omitted.has('bytesUploaded')
    ? undefined
    : (changes.bytesUploaded ?? task.bytesUploaded);
  const totalBytes = omitted.has('totalBytes') ? undefined : (changes.totalBytes ?? task.totalBytes);
  const nextAttemptAt = omitted.has('nextAttemptAt')
    ? undefined
    : (changes.nextAttemptAt ?? task.nextAttemptAt);
  const startedAt = omitted.has('startedAt') ? undefined : (changes.startedAt ?? task.startedAt);
  const completedAt = omitted.has('completedAt')
    ? undefined
    : (changes.completedAt ?? task.completedAt);
  const lastError = omitted.has('lastError') ? undefined : (changes.lastError ?? task.lastError);
  const metadata = omitted.has('metadata') ? undefined : (changes.metadata ?? task.metadata);
  const processingToken = omitted.has('processingToken')
    ? undefined
    : (changes.processingToken ?? task.processingToken);
  const processingStartedAt = omitted.has('processingStartedAt')
    ? undefined
    : (changes.processingStartedAt ?? task.processingStartedAt);
  const remoteId = omitted.has('remoteId') ? undefined : (changes.remoteId ?? task.remoteId);

  return {
    ...next,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(bytesUploaded !== undefined ? { bytesUploaded } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    ...(metadata !== undefined ? { metadata: cloneJson(metadata) } : {}),
    ...(processingToken !== undefined ? { processingToken } : {}),
    ...(processingStartedAt !== undefined ? { processingStartedAt } : {}),
    ...(remoteId !== undefined ? { remoteId } : {}),
  };
}
