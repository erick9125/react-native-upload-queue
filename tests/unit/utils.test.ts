import { describe, expect, it } from 'vitest';
import { createId, parseRetryAfterHeader, serializeMetadata } from '../../src/core/utils.js';

describe('utils', () => {
  it('creates UUID-shaped identifiers', () => {
    const id = createId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('parses Retry-After as seconds or HTTP dates', () => {
    expect(parseRetryAfterHeader('30')).toBe(30_000);
    expect(parseRetryAfterHeader(undefined)).toBeUndefined();
  });

  it('rejects oversized metadata', () => {
    expect(() =>
      serializeMetadata({ blob: 'x'.repeat(20_000) }, 1024),
    ).toThrow(/byte limit/);
  });
});
