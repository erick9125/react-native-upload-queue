import { describe, expect, it } from 'vitest';
import { UploadStateMachine } from '../../src/core/queue/upload-state-machine.js';
import type { UploadStatus } from '../../src/core/models/upload-status.js';
import { InvalidUploadStateError } from '../../src/errors/invalid-upload-state.error.js';

const machine = new UploadStateMachine();

describe('UploadStateMachine', () => {
  it('allows the documented pending transitions', () => {
    expect(machine.canTransition('pending', 'uploading')).toBe(true);
    expect(machine.canTransition('pending', 'paused')).toBe(true);
    expect(machine.canTransition('pending', 'cancelled')).toBe(true);
  });

  it('allows the documented uploading transitions', () => {
    const allowed: UploadStatus[] = [
      'completed',
      'pending',
      'paused',
      'blocked',
      'failed',
      'cancelled',
    ];
    for (const status of allowed) {
      expect(machine.canTransition('uploading', status)).toBe(true);
    }
  });

  it('treats completed and cancelled as final', () => {
    const statuses: UploadStatus[] = [
      'pending',
      'uploading',
      'paused',
      'completed',
      'failed',
      'blocked',
      'cancelled',
    ];

    for (const status of statuses) {
      expect(machine.canTransition('completed', status)).toBe(false);
      expect(machine.canTransition('cancelled', status)).toBe(false);
    }
  });

  it('rejects completed → uploading', () => {
    expect(machine.canTransition('completed', 'uploading')).toBe(false);
    expect(() => machine.assertCanTransition('completed', 'uploading', 'u1')).toThrow(
      InvalidUploadStateError,
    );
  });

  it('allows failed and blocked to return to pending', () => {
    expect(machine.canTransition('failed', 'pending')).toBe(true);
    expect(machine.canTransition('blocked', 'pending')).toBe(true);
    expect(machine.canTransition('paused', 'pending')).toBe(true);
  });
});
