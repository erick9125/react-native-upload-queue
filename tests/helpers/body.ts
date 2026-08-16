import type { UploadTask } from '../../src/core/models/upload-task.js';

/**
 * A Node-friendly request body.
 *
 * The default multipart builder only works inside React Native, which streams
 * `file://` URIs natively, so anything running outside it must supply its own
 * body — exactly what a host would do on web or in tests.
 */
export function buildTestBody(task: UploadTask): FormData {
  const form = new FormData();
  form.append(
    'file',
    new Blob([`contents of ${task.fileName}`], {
      type: task.mimeType ?? 'application/octet-stream',
    }),
    task.fileName,
  );

  if (task.metadata) {
    form.append('metadata', JSON.stringify(task.metadata));
  }

  return form;
}
