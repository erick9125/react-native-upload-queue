import type { UploadStorage } from '../../core/contracts/upload-storage.js';
import type { UploadTask } from '../../core/models/upload-task.js';
import { cloneTask } from '../../core/task.js';
import { UploadNotFoundError } from '../../errors/upload-not-found.error.js';
import { UploadQueueError } from '../../errors/upload-queue.error.js';

export function createMemoryUploadStorage(): UploadStorage {
  const tasks = new Map<string, UploadTask>();

  const adapter: UploadStorage = {
    async initialize(): Promise<void> {
      return;
    },

    async insert(task: UploadTask): Promise<void> {
      if (tasks.has(task.id)) {
        throw new UploadQueueError({
          kind: 'validation',
          message: `Upload ${task.id} is already queued`,
          retryable: false,
        });
      }

      tasks.set(task.id, cloneTask(task));
    },

    async update(task: UploadTask): Promise<void> {
      if (!tasks.has(task.id)) {
        throw new UploadNotFoundError(task.id);
      }

      tasks.set(task.id, cloneTask(task));
    },

    async get(id: string): Promise<UploadTask | null> {
      const task = tasks.get(id);
      return task ? cloneTask(task) : null;
    },

    async getPending(limit: number, nowIso: string): Promise<readonly UploadTask[]> {
      return [...tasks.values()]
        .filter((task) => {
          if (task.status !== 'pending') {
            return false;
          }
          if (!task.nextAttemptAt) {
            return true;
          }
          return task.nextAttemptAt <= nowIso;
        })
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, limit)
        .map((task) => cloneTask(task));
    },

    async getRecoverable(staleBeforeIso: string): Promise<readonly UploadTask[]> {
      return [...tasks.values()]
        .filter(
          (task) =>
            task.status === 'uploading' &&
            task.processingStartedAt !== undefined &&
            task.processingStartedAt <= staleBeforeIso,
        )
        .map((task) => cloneTask(task));
    },

    async claim(id: string, processingToken: string, nowIsoValue: string): Promise<UploadTask | null> {
      const current = tasks.get(id);
      if (!current || current.status !== 'pending') {
        return null;
      }

      if (current.nextAttemptAt && current.nextAttemptAt > nowIsoValue) {
        return null;
      }

      const claimed = cloneTask(
        current,
        {
          status: 'uploading',
          processingToken,
          processingStartedAt: nowIsoValue,
          startedAt: current.startedAt ?? nowIsoValue,
          updatedAt: nowIsoValue,
          progress: 0,
          bytesUploaded: 0,
        },
        ['nextAttemptAt'],
      );
      tasks.set(id, claimed);
      return cloneTask(claimed);
    },

    async delete(id: string): Promise<void> {
      tasks.delete(id);
    },

    async list(): Promise<readonly UploadTask[]> {
      return [...tasks.values()]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((task) => cloneTask(task));
    },

    async deleteCompleted(olderThanIso?: string): Promise<number> {
      let deleted = 0;
      for (const [id, task] of tasks.entries()) {
        if (task.status !== 'completed') {
          continue;
        }
        if (olderThanIso && task.updatedAt > olderThanIso) {
          continue;
        }
        tasks.delete(id);
        deleted += 1;
      }
      return deleted;
    },
  };

  return adapter;
}
