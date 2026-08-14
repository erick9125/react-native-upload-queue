export type UploadErrorKind =
  | 'network'
  | 'authentication'
  | 'authorization'
  | 'rate-limit'
  | 'validation'
  | 'server'
  | 'file-not-found'
  | 'cancelled'
  | 'unknown';

export interface UploadError {
  readonly kind: UploadErrorKind;
  readonly message: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly occurredAt: string;
  readonly retryAfterMs?: number;
}
