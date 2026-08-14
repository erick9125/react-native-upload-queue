export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createNoopLogger(): Logger {
  return {
    debug(): void {
      return;
    },
    info(): void {
      return;
    },
    warn(): void {
      return;
    },
    error(): void {
      return;
    },
  };
}
