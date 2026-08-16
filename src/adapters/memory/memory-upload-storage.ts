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

    async updateOwned(task: UploadTask, processingToken: string): Promise<boolean> {
      const current = tasks.get(task.id);
      if (!current || current.processingToken !== processingToken) {
        return false;
      }

      tasks.set(task.id, cloneTask(task));
      return true;
    },

    async updateProgress(update): Promise<boolean> {
      const current = tasks.get(update.id);
      if (
        !current ||
        current.status !== 'uploading' ||
        current.processingToken !== update.processingToken
      ) {
        return false;
      }

      tasks.set(
        update.id,
        cloneTask(current, {
          progress: update.progress,
          bytesUploaded: update.bytesUploaded,
          updatedAt: update.updatedAt,
          ...(update.totalBytes !== undefined ? { totalBytes: update.totalBytes } : {}),
        }),
      );
      return true;
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

    async getRecoverable(staleBeforeIso: string, limit?: number): Promise<readonly UploadTask[]> {
      const recoverable = [...tasks.values()]
        .filter(
          (task) =>
            task.status === 'uploading' &&
            task.processingStartedAt !== undefined &&
            task.processingStartedAt <= staleBeforeIso,
        )
        .sort((left, right) =>
          (left.processingStartedAt ?? '').localeCompare(right.processingStartedAt ?? ''),
        );

      return (limit === undefined ? recoverable : recoverable.slice(0, limit)).map((task) =>
        cloneTask(task),
      );
    },

    async recoverAbandoned(staleBeforeIso: string, updatedAt: string): Promise<number> {
      let recovered = 0;
      for (const [id, task] of tasks.entries()) {
        if (
          task.status !== 'uploading' ||
          task.processingStartedAt === undefined ||
          task.processingStartedAt > staleBeforeIso
        ) {
          continue;
        }

        tasks.set(
          id,
          cloneTask(task, { status: 'pending', updatedAt, progress: 0 }, [
            'processingToken',
            'processingStartedAt',
            'nextAttemptAt',
          ]),
        );
        recovered += 1;
      }
      return recovered;
    },

    async getEarliestNextAttemptAt(): Promise<string | null> {
      let earliest: string | undefined;
      for (const task of tasks.values()) {
        if (task.status !== 'pending' || !task.nextAttemptAt) {
          continue;
        }
        if (earliest === undefined || task.nextAttemptAt < earliest) {
          earliest = task.nextAttemptAt;
        }
      }
      return earliest ?? null;
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
        // Ages by when the upload finished, not when the row was last touched.
        if (olderThanIso && (task.completedAt ?? task.updatedAt) > olderThanIso) {
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
