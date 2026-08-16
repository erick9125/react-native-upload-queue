import type { UploadTask } from '../../core/models/upload-task.js';
import { UploadQueueError } from '../../errors/upload-queue.error.js';

export interface ReactNativeFilePart {
  readonly uri: string;
  readonly name: string;
  readonly type: string;
}

export function buildMultipartFilePart(task: UploadTask): ReactNativeFilePart {
  return {
    uri: task.fileUri,
    name: task.fileName,
    type: task.mimeType ?? 'application/octet-stream',
  };
}

function isReactNativeRuntime(): boolean {
  const runtime = globalThis as { navigator?: { product?: string } };
  return runtime.navigator?.product === 'ReactNative';
}

/**
 * Appends the file part the way React Native expects: a `{ uri, name, type }`
 * object that its networking layer streams from disk.
 *
 * Outside React Native this throws rather than guessing. The previous fallback
 * put the URI *string* in the body, so a host running in Node or a browser
 * uploaded a few dozen bytes of `"file://photo.jpg"` with a 200 response and no
 * indication anything was wrong.
 */
export function appendUploadFile(formData: FormData, task: UploadTask, fieldName: string): void {
  if (!isReactNativeRuntime()) {
    throw new UploadQueueError({
      kind: 'validation',
      message:
        'The default multipart body only works in React Native, which streams file:// URIs natively. ' +
        'Outside React Native, pass createHttpUploadTransport({ buildBody }) to build the request body yourself.',
      retryable: false,
    });
  }

  formData.append(fieldName, buildMultipartFilePart(task) as unknown as Blob);

  if (task.metadata) {
    formData.append('metadata', JSON.stringify(task.metadata));
  }
}
