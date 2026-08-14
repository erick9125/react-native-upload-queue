export class ConcurrencyController {
  private active = 0;
  private peak = 0;

  constructor(private readonly limit: number) {}

  get activeCount(): number {
    return this.active;
  }

  get peakCount(): number {
    return this.peak;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.active);
  }

  tryAcquire(): boolean {
    if (this.active >= this.limit) {
      return false;
    }

    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    return true;
  }

  release(): void {
    if (this.active > 0) {
      this.active -= 1;
    }
  }
}
