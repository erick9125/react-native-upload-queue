import type { EnqueueUploadInput } from '../../src/core/models/upload-task.js';

export function createEnqueueInput(
  overrides: Partial<EnqueueUploadInput> = {},
): EnqueueUploadInput {
  return {
    fileUri: overrides.fileUri ?? 'file://photo.jpg',
    fileName: overrides.fileName ?? 'photo.jpg',
    destination: overrides.destination ?? '/uploads',
    ...(overrides.mimeType !== undefined ? { mimeType: overrides.mimeType } : { mimeType: 'image/jpeg' }),
    ...(overrides.size !== undefined ? { size: overrides.size } : { size: 1_024 }),
    ...(overrides.method !== undefined ? { method: overrides.method } : {}),
    ...(overrides.maxAttempts !== undefined ? { maxAttempts: overrides.maxAttempts } : {}),
    ...(overrides.idempotencyKey !== undefined ? { idempotencyKey: overrides.idempotencyKey } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
}
