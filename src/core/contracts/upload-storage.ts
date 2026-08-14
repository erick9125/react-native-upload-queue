import type { UploadTask } from '../models/upload-task.js';

export interface UploadStorage {
  initialize(): Promise<void>;
  insert(task: UploadTask): Promise<void>;
  update(task: UploadTask): Promise<void>;
  get(id: string): Promise<UploadTask | null>;
  getPending(limit: number, nowIso: string): Promise<readonly UploadTask[]>;
  getRecoverable(staleBeforeIso: string): Promise<readonly UploadTask[]>;
  claim(id: string, processingToken: string, nowIso: string): Promise<UploadTask | null>;
  delete(id: string): Promise<void>;
  list(): Promise<readonly UploadTask[]>;
  deleteCompleted(olderThanIso?: string): Promise<number>;
  close?(): Promise<void>;
}
