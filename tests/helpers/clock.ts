import type { Clock } from '../../src/core/contracts/clock.js';

export function createFakeClock(start = new Date('2026-08-13T15:00:00.000Z')): Clock & {
  advance(ms: number): void;
  set(date: Date): void;
} {
  let current = start;

  return {
    now(): Date {
      return current;
    },
    advance(ms: number): void {
      current = new Date(current.getTime() + ms);
    },
    set(date: Date): void {
      current = date;
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
