import { describe, expect, it } from 'vitest';
import { ExponentialBackoffStrategy } from '../../src/core/retry/exponential-backoff.js';
import { FixedBackoffStrategy } from '../../src/core/retry/fixed-backoff.js';

describe('ExponentialBackoffStrategy', () => {
  it('doubles the delay each attempt and caps at maxDelayMs', () => {
    const strategy = new ExponentialBackoffStrategy(2_000, 32_000, 2, false);

    expect(strategy.nextDelayMs(1)).toBe(2_000);
    expect(strategy.nextDelayMs(2)).toBe(4_000);
    expect(strategy.nextDelayMs(3)).toBe(8_000);
    expect(strategy.nextDelayMs(4)).toBe(16_000);
    expect(strategy.nextDelayMs(5)).toBe(32_000);
    expect(strategy.nextDelayMs(6)).toBe(32_000);
  });

  it('applies jitter between 50% and 150% of the capped delay', () => {
    const strategy = new ExponentialBackoffStrategy(2_000, 60_000, 2, true, () => 0.5);
    expect(strategy.nextDelayMs(1)).toBe(2_000);
  });
});

describe('FixedBackoffStrategy', () => {
  it('returns the same delay for every attempt', () => {
    const strategy = new FixedBackoffStrategy(3_000, 5_000);
    expect(strategy.nextDelayMs(1)).toBe(3_000);
    expect(strategy.nextDelayMs(8)).toBe(3_000);
  });
});
