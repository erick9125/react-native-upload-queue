import type {
  UploadTransport,
  UploadTransportContext,
  UploadTransportResult,
} from '../../core/contracts/upload-transport.js';
import type { UploadTask } from '../../core/models/upload-task.js';
import { parseRetryAfterHeader } from '../../core/utils.js';
import { appendUploadFile } from './multipart-body-builder.js';

export interface FetchLikeHeaders {
  get(name: string): string | null;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  ok: boolean;
  headers: FetchLikeHeaders;
  text(): Promise<string>;
}>;

export interface HttpUploadTransportOptions {
  readonly baseUrl: string;
  readonly getAccessToken?: () => Promise<string | undefined>;
  readonly idempotencyHeader?: string;
  readonly fieldName?: string;
  readonly defaultHeaders?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
  readonly buildBody?: (task: UploadTask) => Promise<BodyInit> | BodyInit;
}

function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function parseBody(raw: string): unknown {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function readRemoteId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  if ('id' in body && typeof body.id === 'string') {
    return body.id;
  }

  if ('remoteId' in body && typeof body.remoteId === 'string') {
    return body.remoteId;
  }

  return undefined;
}

function combineSignals(signal: AbortSignal, timeoutMs: number | undefined): AbortSignal {
  if (timeoutMs === undefined) {
    return signal;
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeout]);
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal.aborted || timeout.aborted) {
    controller.abort();
    return controller.signal;
  }

  signal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function buildDefaultBody(task: UploadTask, fieldName: string): FormData {
  const formData = new FormData();
  appendUploadFile(formData, task, fieldName);
  return formData;
}

export function createHttpUploadTransport(options: HttpUploadTransportOptions): UploadTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const idempotencyHeader = options.idempotencyHeader ?? 'Idempotency-Key';
  const fieldName = options.fieldName ?? 'file';

  if (!fetchImpl) {
    throw new Error('createHttpUploadTransport requires a fetch implementation');
  }

  return {
    async upload(
      task: UploadTask,
      context: UploadTransportContext,
    ): Promise<UploadTransportResult> {
      const headers: Record<string, string> = {
        ...(options.defaultHeaders ?? {}),
        [idempotencyHeader]: task.idempotencyKey,
      };

      if (options.getAccessToken) {
        const token = await options.getAccessToken();
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
      }

      const body = options.buildBody
        ? await options.buildBody(task)
        : buildDefaultBody(task, fieldName);

      const signal = combineSignals(context.signal, options.timeoutMs);
      context.onProgress(0, task.size);

      const response = await fetchImpl(joinUrl(options.baseUrl, task.destination), {
        method: task.method,
        headers,
        body,
        signal,
      });

      const raw = await response.text();
      const parsed = parseBody(raw);
      const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
      const remoteId = readRemoteId(parsed);

      if (response.status >= 200 && response.status < 300) {
        context.onProgress(task.size ?? 1, task.size ?? 1);
      }

      return {
        statusCode: response.status,
        response: parsed,
        ...(remoteId !== undefined ? { remoteId } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    },
  };
}
