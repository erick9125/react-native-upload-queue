import type { RetryStrategy } from '../contracts/retry-strategy.js';

export interface ExponentialBackoffOptions {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitter?: boolean;
  readonly random?: () => number;
}

export class ExponentialBackoffStrategy implements RetryStrategy {
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly multiplier: number;
  private readonly jitter: boolean;
  private readonly random: () => number;

  constructor(
    initialDelayMs = 2_000,
    maxDelayMs = 60_000,
    multiplier = 2,
    jitter = true,
    random: () => number = Math.random,
  ) {
    this.initialDelayMs = initialDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.multiplier = multiplier;
    this.jitter = jitter;
    this.random = random;
  }

  nextDelayMs(attempt: number): number {
    const exponential = this.initialDelayMs * this.multiplier ** Math.max(attempt - 1, 0);
    const capped = Math.min(exponential, this.maxDelayMs);

    if (!this.jitter) {
      return capped;
    }

    const jitterFactor = 0.5 + this.random();
    return Math.floor(capped * jitterFactor);
  }
}

export function createExponentialBackoff(
  options: ExponentialBackoffOptions = {},
): ExponentialBackoffStrategy {
  return new ExponentialBackoffStrategy(
    options.initialDelayMs ?? 2_000,
    options.maxDelayMs ?? 60_000,
    options.multiplier ?? 2,
    options.jitter ?? true,
    options.random ?? Math.random,
  );
}
