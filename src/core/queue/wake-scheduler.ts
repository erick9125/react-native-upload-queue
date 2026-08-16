import type { Clock } from '../contracts/clock.js';

export interface WakeSchedulerOptions {
  readonly clock: Clock;
  /** Earliest scheduled retry across pending uploads, or null when none is due. */
  readonly getEarliestNextAttemptAt: () => Promise<string | null>;
  readonly onWake: () => void;
}

/**
 * Owns the single timer that wakes the queue when the next retry comes due.
 *
 * It asks storage for one value rather than scanning the queue: the previous
 * implementation loaded every row — completed history included — and
 * deserialized each one just to compute a minimum.
 */
export class WakeScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: WakeSchedulerOptions) {}

  async schedule(): Promise<void> {
    this.cancel();

    const earliestIso = await this.options.getEarliestNextAttemptAt();
    if (earliestIso === null) {
      return;
    }

    const earliest = Date.parse(earliestIso);
    if (Number.isNaN(earliest)) {
      return;
    }

    const delayMs = Math.max(0, earliest - this.options.clock.now().getTime());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.options.onWake();
    }, delayMs);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
