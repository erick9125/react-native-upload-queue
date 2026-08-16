import { describe, expect, it } from 'vitest';
import {
  appendUploadFile,
  buildMultipartFilePart,
} from '../../src/adapters/http/multipart-body-builder.js';
import type { UploadTask } from '../../src/core/models/upload-task.js';
import { UploadQueueError } from '../../src/errors/upload-queue.error.js';

/**
 * Records what was appended instead of storing it.
 *
 * React Native's FormData keeps a `{ uri, name, type }` object verbatim and its
 * networking layer streams the file from that URI. Node's FormData would coerce
 * the same object to the string "[object Object]", so asserting through a real
 * Node FormData would test Node's coercion rather than our contract with RN.
 */
class RecordingFormData {
  readonly entries: Array<{ name: string; value: unknown }> = [];

  append(name: string, value: unknown): void {
    this.entries.push({ name, value });
  }
}

/**
 * Runs `fn` with the runtime marker React Native sets. This is the only way to
 * reach the device code path from Node; it is not a substitute for running the
 * upload on a real device, which the example app exists for.
 */
function withReactNativeRuntime<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { product: 'ReactNative' },
    configurable: true,
    writable: true,
  });

  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'navigator', original);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  }
}

function task(overrides: Partial<UploadTask> = {}): UploadTask {
  return {
    id: 'upload-1',
    fileUri: 'file:///var/mobile/Containers/Data/tmp/IMG_0042.HEIC',
    fileName: 'IMG_0042.HEIC',
    mimeType: 'image/heic',
    destination: '/uploads',
    method: 'POST',
    status: 'uploading',
    attempts: 0,
    maxAttempts: 5,
    idempotencyKey: 'idem-1',
    progress: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildMultipartFilePart', () => {
  it('maps the task onto the shape React Native streams from disk', () => {
    expect(buildMultipartFilePart(task())).toEqual({
      uri: 'file:///var/mobile/Containers/Data/tmp/IMG_0042.HEIC',
      name: 'IMG_0042.HEIC',
      type: 'image/heic',
    });
  });

  it('falls back to a generic content type when the task has no mimeType', () => {
    const withoutMimeType: UploadTask = {
      id: 'upload-2',
      fileUri: 'file:///tmp/scan.bin',
      fileName: 'scan.bin',
      destination: '/uploads',
      method: 'POST',
      status: 'uploading',
      attempts: 0,
      maxAttempts: 5,
      idempotencyKey: 'idem-2',
      progress: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(buildMultipartFilePart(withoutMimeType).type).toBe('application/octet-stream');
  });
});

describe('appendUploadFile inside the React Native runtime', () => {
  it('appends the file part object itself, not a stringified copy', () => {
    const form = new RecordingFormData();

    withReactNativeRuntime(() => {
      appendUploadFile(form as unknown as FormData, task(), 'file');
    });

    expect(form.entries).toHaveLength(1);
    expect(form.entries[0]?.name).toBe('file');
    expect(form.entries[0]?.value).toEqual({
      uri: 'file:///var/mobile/Containers/Data/tmp/IMG_0042.HEIC',
      name: 'IMG_0042.HEIC',
      type: 'image/heic',
    });
    // The URI must arrive as a property of the part, never as the body itself.
    expect(typeof form.entries[0]?.value).toBe('object');
  });

  it('honours a custom field name', () => {
    const form = new RecordingFormData();

    withReactNativeRuntime(() => {
      appendUploadFile(form as unknown as FormData, task(), 'attachment');
    });

    expect(form.entries[0]?.name).toBe('attachment');
  });

  it('appends metadata as a JSON string alongside the file', () => {
    const form = new RecordingFormData();

    withReactNativeRuntime(() => {
      appendUploadFile(
        form as unknown as FormData,
        task({ metadata: { documentType: 'invoice', siteId: 42 } }),
        'file',
      );
    });

    expect(form.entries).toHaveLength(2);
    expect(form.entries[1]?.name).toBe('metadata');
    expect(JSON.parse(String(form.entries[1]?.value))).toEqual({
      documentType: 'invoice',
      siteId: 42,
    });
  });

  it('omits the metadata part when the task carries none', () => {
    const form = new RecordingFormData();

    withReactNativeRuntime(() => {
      appendUploadFile(form as unknown as FormData, task(), 'file');
    });

    expect(form.entries.map((entry) => entry.name)).toEqual(['file']);
  });

  it('still throws once the runtime marker is gone', () => {
    const form = new RecordingFormData();

    withReactNativeRuntime(() => {
      appendUploadFile(form as unknown as FormData, task(), 'file');
    });

    expect(() => appendUploadFile(form as unknown as FormData, task(), 'file')).toThrowError(
      UploadQueueError,
    );
    expect(form.entries).toHaveLength(1);
  });
});
