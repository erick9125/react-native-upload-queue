import type { UploadQueueEvent } from '../models/upload-event.js';

export type UploadEventListener = (event: UploadQueueEvent) => void;

export class UploadEventEmitter {
  private readonly listeners = new Set<UploadEventListener>();

  subscribe(listener: UploadEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: UploadQueueEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscribers own their error handling.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
