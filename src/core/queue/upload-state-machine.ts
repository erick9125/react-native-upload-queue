import { InvalidUploadStateError } from '../../errors/invalid-upload-state.error.js';
import type { UploadStatus } from '../models/upload-status.js';

const TRANSITIONS: Readonly<Record<UploadStatus, readonly UploadStatus[]>> = {
  // `pending -> pending` keeps retry() usable on an upload that is already
  // queued: it resets the attempt counter, which is a meaningful request even
  // when the status does not change. resume() short-circuits the same case.
  pending: ['uploading', 'paused', 'cancelled', 'pending'],
  uploading: ['completed', 'pending', 'paused', 'blocked', 'failed', 'cancelled'],
  paused: ['pending', 'cancelled'],
  blocked: ['pending', 'failed', 'cancelled'],
  failed: ['pending', 'cancelled'],
  completed: [],
  cancelled: [],
};

export class UploadStateMachine {
  canTransition(from: UploadStatus, to: UploadStatus): boolean {
    return TRANSITIONS[from].includes(to);
  }

  assertCanTransition(from: UploadStatus, to: UploadStatus, uploadId: string): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidUploadStateError(uploadId, from, to);
    }
  }
}
