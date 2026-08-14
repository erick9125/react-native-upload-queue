export type UploadSkipReason = 'offline' | 'busy' | 'stopped';

export interface UploadProcessResult {
  readonly processed: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly deferred: number;
  readonly cancelled: number;
  readonly skipped: boolean;
  readonly reason?: UploadSkipReason;
}
