import type { UploadTask } from '../models/upload-task.js';

/** Narrow write issued on every persisted progress tick. */
export interface UploadProgressUpdate {
  readonly id: string;
  readonly processingToken: string;
  readonly progress: number;
  readonly bytesUploaded: number;
  readonly updatedAt: string;
  readonly totalBytes?: number;
}

export interface UploadStorage {
  initialize(): Promise<void>;
  insert(task: UploadTask): Promise<void>;
  /**
   * Unconditional write. Use it for owner-independent transitions driven by the
   * user (pause, resume, cancel, manual retry) and for recovery.
   */
  update(task: UploadTask): Promise<void>;
  /**
   * Fenced write: persists `task` only while `processingToken` still matches the
   * claim recorded on the row, and reports whether the write landed.
   *
   * A processor that lost its claim — because the upload was paused, cancelled
   * or recovered by another worker while its attempt was in flight — must not
   * overwrite that newer state with the snapshot it took before the attempt.
   */
  updateOwned(task: UploadTask, processingToken: string): Promise<boolean>;
  /**
   * Fenced write of progress columns only. Called on every persisted tick, so it
   * deliberately avoids rewriting — and re-serializing — the whole row.
   */
  updateProgress(update: UploadProgressUpdate): Promise<boolean>;
  get(id: string): Promise<UploadTask | null>;
  getPending(limit: number, nowIso: string): Promise<readonly UploadTask[]>;
  getRecoverable(staleBeforeIso: string, limit?: number): Promise<readonly UploadTask[]>;
  /**
   * Returns every upload stuck in `uploading` since before `staleBeforeIso` to
   * `pending` in one statement, and reports how many were recovered. Runs at
   * boot, where a read-then-write-per-row loop costs 1+N round trips.
   */
  recoverAbandoned(staleBeforeIso: string, updatedAt: string): Promise<number>;
  /**
   * Earliest scheduled retry among pending uploads, or null when none is
   * scheduled. Backs the wake timer without loading the queue into memory.
   */
  getEarliestNextAttemptAt(): Promise<string | null>;
  claim(id: string, processingToken: string, nowIso: string): Promise<UploadTask | null>;
  delete(id: string): Promise<void>;
  list(): Promise<readonly UploadTask[]>;
  deleteCompleted(olderThanIso?: string): Promise<number>;
  close?(): Promise<void>;
}
