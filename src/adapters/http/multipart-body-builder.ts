import type { UploadTask } from '../../core/models/upload-task.js';

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

export function appendUploadFile(formData: FormData, task: UploadTask, fieldName: string): void {
  const part = buildMultipartFilePart(task);

  if (isReactNativeRuntime()) {
    formData.append(fieldName, part as unknown as Blob);
  } else {
    formData.append(fieldName, new Blob([part.uri], { type: part.type }), part.name);
  }

  if (task.metadata) {
    formData.append('metadata', JSON.stringify(task.metadata));
  }
}
