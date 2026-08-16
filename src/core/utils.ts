export function createId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Takes the date explicitly so callers cannot bypass the injected `Clock`. */
export function nowIso(date: Date): string {
  return date.toISOString();
}

export const DEFAULT_METADATA_MAX_BYTES = 8 * 1024;

/** Mirrors the `max_attempts` default in the SQLite schema. */
export const DEFAULT_MAX_ATTEMPTS = 5;

export function serializeMetadata(
  value: Record<string, unknown> | undefined,
  maxBytes = DEFAULT_METADATA_MAX_BYTES,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `Upload metadata must be JSON-serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new Error(
      `Upload metadata exceeds the ${maxBytes} byte limit. Keep metadata small and structured.`,
    );
  }

  return serialized;
}

export function cloneJson<TValue>(value: TValue): TValue {
  if (value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as TValue;
}

/**
 * `now` is a parameter so the HTTP-date branch honours the injected clock like
 * everything else, instead of reaching for `Date.now()` and being untestable.
 */
export function parseRetryAfterHeader(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!value) {
    return undefined;
  }

  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1_000);
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - now.getTime());
  }

  return undefined;
}

function hasErrorName(error: unknown, name: string): boolean {
  if (error instanceof Error) {
    return error.name === name;
  }

  // DOMException is not an Error in every runtime, so fall back to duck typing.
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name;
}

export function isAbortError(error: unknown): boolean {
  return hasErrorName(error, 'AbortError');
}

export function isTimeoutError(error: unknown): boolean {
  return hasErrorName(error, 'TimeoutError');
}

export function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 0;
  }

  return Math.min(1, Math.max(0, progress));
}
