import { describe, expect, it, vi } from 'vitest';
import { createMemoryFileProvider } from '../../src/adapters/memory/memory-file-provider.js';
import {
  createManualConnectivity,
  createNetInfoConnectivityProvider,
} from '../../src/adapters/netinfo/netinfo-connectivity-provider.js';
import { UploadEventEmitter } from '../../src/core/events/upload-event-emitter.js';
import { ConcurrencyController } from '../../src/core/queue/concurrency-controller.js';
import { QueueCoordinator } from '../../src/core/queue/queue-coordinator.js';
import { WakeScheduler } from '../../src/core/queue/wake-scheduler.js';
import { clampProgress, cloneJson, createId } from '../../src/core/utils.js';
import { createFakeClock, delay } from '../helpers/clock.js';

describe('WakeScheduler', () => {
  it('fires once the earliest retry comes due', async () => {
    const clock = createFakeClock(new Date('2026-01-01T00:00:00.000Z'));
    const woken: number[] = [];

    const scheduler = new WakeScheduler({
      clock,
      getEarliestNextAttemptAt: async () => '2026-01-01T00:00:00.030Z',
      onWake: () => woken.push(1),
    });

    await scheduler.schedule();
    expect(woken).toHaveLength(0);

    await delay(80);
    expect(woken).toHaveLength(1);
  });

  it('does nothing when no retry is scheduled', async () => {
    const clock = createFakeClock();
    const onWake = vi.fn();
    const scheduler = new WakeScheduler({
      clock,
      getEarliestNextAttemptAt: async () => null,
      onWake,
    });

    await scheduler.schedule();
    await delay(30);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('ignores an unparseable timestamp instead of scheduling at NaN', async () => {
    const onWake = vi.fn();
    const scheduler = new WakeScheduler({
      clock: createFakeClock(),
      getEarliestNextAttemptAt: async () => 'not-a-date',
      onWake,
    });

    await scheduler.schedule();
    await delay(30);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('replaces the pending timer when rescheduled and stops on cancel', async () => {
    const clock = createFakeClock(new Date('2026-01-01T00:00:00.000Z'));
    const onWake = vi.fn();
    const scheduler = new WakeScheduler({
      clock,
      getEarliestNextAttemptAt: async () => '2026-01-01T00:00:00.030Z',
      onWake,
    });

    await scheduler.schedule();
    await scheduler.schedule();
    scheduler.cancel();

    await delay(80);
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe('ConcurrencyController', () => {
  it('hands out no more than the limit and tracks the peak', () => {
    const controller = new ConcurrencyController(2);

    expect(controller.remaining).toBe(2);
    expect(controller.tryAcquire()).toBe(true);
    expect(controller.tryAcquire()).toBe(true);
    expect(controller.tryAcquire()).toBe(false);
    expect(controller.activeCount).toBe(2);
    expect(controller.peakCount).toBe(2);
    expect(controller.remaining).toBe(0);

    controller.release();
    expect(controller.activeCount).toBe(1);
    expect(controller.tryAcquire()).toBe(true);
  });

  it('ignores a release with nothing outstanding', () => {
    const controller = new ConcurrencyController(1);
    controller.release();
    expect(controller.activeCount).toBe(0);
  });
});

describe('QueueCoordinator', () => {
  it('reports whether a run is in progress', async () => {
    const coordinator = new QueueCoordinator();
    expect(coordinator.isRunning).toBe(false);

    const running = coordinator.runExclusive(async () => {
      expect(coordinator.isRunning).toBe(true);
      return 'done';
    });

    expect(await running).toEqual({ ran: true, result: 'done' });
    expect(coordinator.isRunning).toBe(false);
  });

  it('releases the lock when the task throws', async () => {
    const coordinator = new QueueCoordinator();
    await expect(
      coordinator.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrowError('boom');
    expect(coordinator.isRunning).toBe(false);
  });
});

describe('UploadEventEmitter', () => {
  it('keeps delivering to other listeners when one throws', () => {
    const emitter = new UploadEventEmitter();
    const seen: string[] = [];

    emitter.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    emitter.subscribe((event) => seen.push(event.type));

    emitter.emit({ type: 'upload.paused', uploadId: 'a' });
    expect(seen).toEqual(['upload.paused']);
  });

  it('stops delivering after unsubscribe and after clear', () => {
    const emitter = new UploadEventEmitter();
    const seen: string[] = [];
    const unsubscribe = emitter.subscribe((event) => seen.push(event.type));

    emitter.emit({ type: 'upload.paused', uploadId: 'a' });
    unsubscribe();
    emitter.emit({ type: 'upload.cancelled', uploadId: 'a' });

    emitter.subscribe((event) => seen.push(event.type));
    emitter.clear();
    emitter.emit({ type: 'upload.cancelled', uploadId: 'a' });

    expect(seen).toEqual(['upload.paused']);
  });
});

describe('memory file provider', () => {
  it('reports sizes, missing files, and unknown URIs', async () => {
    const files = createMemoryFileProvider({ 'file://a.jpg': { size: 10 } });

    expect(await files.exists('file://a.jpg')).toBe(true);
    expect(await files.getSize('file://a.jpg')).toBe(10);
    // Unknown URIs are assumed present: the provider is an allow-list of
    // overrides, not a filesystem.
    expect(await files.exists('file://unknown.jpg')).toBe(true);
    expect(await files.getSize('file://unknown.jpg')).toBeUndefined();

    files.remove('file://a.jpg');
    expect(await files.exists('file://a.jpg')).toBe(false);

    files.setFile('file://a.jpg', { size: 20 });
    expect(await files.exists('file://a.jpg')).toBe(true);
    expect(await files.getSize('file://a.jpg')).toBe(20);
  });
});

describe('connectivity providers', () => {
  it.each([
    { state: { isConnected: false }, online: false },
    { state: { isConnected: true, isInternetReachable: false }, online: false },
    { state: { isConnected: true }, online: true },
    { state: { isConnected: null, isInternetReachable: true }, online: true },
    { state: { isConnected: null }, online: false },
  ])('resolves $state to online=$online', async ({ state, online }) => {
    const provider = createNetInfoConnectivityProvider({
      netInfo: {
        async fetch() {
          return state;
        },
        addEventListener() {
          return () => undefined;
        },
      },
    });

    expect(await provider.isOnline()).toBe(online);
  });

  it('forwards NetInfo transitions to subscribers', async () => {
    let emit: ((state: { isConnected: boolean }) => void) | undefined;
    const provider = createNetInfoConnectivityProvider({
      netInfo: {
        async fetch() {
          return { isConnected: true };
        },
        addEventListener(listener) {
          emit = listener;
          return () => {
            emit = undefined;
          };
        },
      },
    });

    const seen: boolean[] = [];
    const unsubscribe = provider.subscribe((online) => seen.push(online));
    emit?.({ isConnected: false });
    emit?.({ isConnected: true });
    unsubscribe();

    expect(seen).toEqual([false, true]);
  });

  it('only notifies the manual provider on an actual change', async () => {
    const manual = createManualConnectivity(true);
    const seen: boolean[] = [];
    manual.subscribe((online) => seen.push(online));

    manual.setOnline(true);
    manual.setOnline(false);
    manual.setOnline(false);
    manual.setOnline(true);

    expect(seen).toEqual([false, true]);
    expect(await manual.isOnline()).toBe(true);
  });
});

describe('utils', () => {
  it('produces distinct v4-shaped ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('falls back to Math.random when the crypto helpers are absent', () => {
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      expect(createId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });

  it('passes undefined through cloneJson untouched', () => {
    expect(cloneJson(undefined)).toBeUndefined();
    const source = { nested: { value: 1 } };
    const copy = cloneJson(source);
    expect(copy).toEqual(source);
    expect(copy.nested).not.toBe(source.nested);
  });

  it('clamps progress into 0..1 and rejects non-finite input', () => {
    expect(clampProgress(-1)).toBe(0);
    expect(clampProgress(0.5)).toBe(0.5);
    expect(clampProgress(2)).toBe(1);
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
