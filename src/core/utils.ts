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

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

export const DEFAULT_METADATA_MAX_BYTES = 8 * 1024;

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

export function parseRetryAfterHeader(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1_000);
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 0;
  }

  return Math.min(1, Math.max(0, progress));
}
