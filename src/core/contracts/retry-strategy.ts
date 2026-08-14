export interface RetryStrategy {
  nextDelayMs(attempt: number): number;
}

export type RetryStrategyName = 'exponential' | 'fixed';

export interface RetryConfig {
  readonly maxAttempts?: number;
  readonly strategy?: RetryStrategyName | RetryStrategy;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitter?: boolean;
}
