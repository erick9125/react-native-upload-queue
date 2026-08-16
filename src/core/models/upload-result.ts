export type UploadSkipReason = 'offline' | 'busy';

export interface UploadProcessResult {
  readonly processed: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly deferred: number;
  readonly cancelled: number;
  /** Uploads whose processing threw instead of resolving to a status. */
  readonly errored: number;
  readonly skipped: boolean;
  readonly reason?: UploadSkipReason;
}
