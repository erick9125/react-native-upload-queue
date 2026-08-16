import type {
  UploadTransport,
  UploadTransportContext,
  UploadTransportResult,
} from '../../core/contracts/upload-transport.js';
import type { Clock } from '../../core/contracts/clock.js';
import { createSystemClock } from '../../core/contracts/clock.js';
import type { UploadTask } from '../../core/models/upload-task.js';
import { UploadQueueError } from '../../errors/upload-queue.error.js';
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
  /**
   * Allows `task.destination` to be a full URL instead of a path under
   * `baseUrl`. Off by default. Even when enabled, the access token is only sent
   * to the base URL's own origin.
   */
  readonly allowAbsoluteDestinations?: boolean;
  /** Used to resolve `Retry-After` when the server sends an HTTP date. */
  readonly clock?: Clock;
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Scheme + authority, lowercased. Avoids depending on `URL`, which React Native only partially implements. */
function originOf(url: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(url)?.[1]?.toLowerCase();
}

function joinUrl(baseUrl: string, path: string, allowAbsolute: boolean): string {
  if (ABSOLUTE_URL.test(path)) {
    if (!allowAbsolute) {
      throw new UploadQueueError({
        kind: 'validation',
        message:
          'Upload destination must be a path relative to baseUrl. Pass allowAbsoluteDestinations: true to send uploads to absolute URLs.',
        retryable: false,
      });
    }
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

interface CombinedSignal {
  readonly signal: AbortSignal;
  /** True when the deadline fired, as opposed to the caller cancelling. */
  readonly timedOut: boolean;
  /** Clears the deadline and detaches the listener. Must run on every exit path. */
  release(): void;
}

/**
 * Merges the caller's cancellation with an optional deadline.
 *
 * Deliberately built from `AbortController` and `setTimeout` rather than
 * `AbortSignal.timeout` / `AbortSignal.any`: those are missing on older Hermes,
 * and the previous implementation called `AbortSignal.timeout` before checking
 * whether `any` existed, so it threw instead of degrading. It also never removed
 * its listeners, leaving the deadline timer alive after a successful upload.
 */
function combineSignals(signal: AbortSignal, timeoutMs: number | undefined): CombinedSignal {
  if (timeoutMs === undefined) {
    return { signal, timedOut: false, release: () => undefined };
  }

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = (): void => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', onAbort);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    release() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
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
  const allowAbsoluteDestinations = options.allowAbsoluteDestinations ?? false;
  const clock = options.clock ?? createSystemClock();

  if (!fetchImpl) {
    throw new Error('createHttpUploadTransport requires a fetch implementation');
  }

  const baseOrigin = originOf(options.baseUrl);

  return {
    async upload(
      task: UploadTask,
      context: UploadTransportContext,
    ): Promise<UploadTransportResult> {
      const url = joinUrl(options.baseUrl, task.destination, allowAbsoluteDestinations);

      const headers: Record<string, string> = {
        ...(options.defaultHeaders ?? {}),
        [idempotencyHeader]: task.idempotencyKey,
      };

      // Credentials follow the base URL, never an arbitrary destination. A
      // destination sourced from server data or a deep link must not be able to
      // walk off with the bearer token.
      const targetOrigin = originOf(url);
      const sameOrigin = targetOrigin === undefined || targetOrigin === baseOrigin;

      if (options.getAccessToken && sameOrigin) {
        const token = await options.getAccessToken();
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
      }

      const body = options.buildBody
        ? await options.buildBody(task)
        : buildDefaultBody(task, fieldName);

      const combined = combineSignals(context.signal, options.timeoutMs);
      context.onProgress(0, task.size);

      try {
        const response = await fetchImpl(url, {
          method: task.method,
          headers,
          body,
          signal: combined.signal,
        });

        const raw = await response.text();
        const parsed = parseBody(raw);
        const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'), clock.now());
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
      } catch (error) {
        // Report the deadline as what it is. Leaving it as a bare abort made
        // classification depend on the runtime's wording of the abort message.
        if (combined.timedOut && !context.signal.aborted) {
          throw new UploadQueueError({
            kind: 'network',
            message: `Upload timed out after ${String(options.timeoutMs)} ms`,
            retryable: true,
            cause: error,
          });
        }
        throw error;
      } finally {
        combined.release();
      }
    },
  };
}
