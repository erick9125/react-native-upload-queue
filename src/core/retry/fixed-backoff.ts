import type { RetryStrategy } from '../contracts/retry-strategy.js';

export interface FixedBackoffOptions {
  readonly delayMs?: number;
  readonly maxDelayMs?: number;
}

export class FixedBackoffStrategy implements RetryStrategy {
  private readonly delayMs: number;
  private readonly maxDelayMs: number;

  constructor(delayMs = 2_000, maxDelayMs = delayMs) {
    this.delayMs = delayMs;
    this.maxDelayMs = maxDelayMs;
  }

  nextDelayMs(_attempt: number): number {
    return Math.min(this.delayMs, this.maxDelayMs);
  }
}

export function createFixedBackoff(options: FixedBackoffOptions = {}): FixedBackoffStrategy {
  const delayMs = options.delayMs ?? 2_000;
  return new FixedBackoffStrategy(delayMs, options.maxDelayMs ?? delayMs);
}
