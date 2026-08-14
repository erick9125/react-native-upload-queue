export class QueueCoordinator {
  private running = false;

  async runExclusive<T>(
    task: () => Promise<T>,
  ): Promise<{ ran: true; result: T } | { ran: false }> {
    if (this.running) {
      return { ran: false };
    }

    this.running = true;
    try {
      const result = await task();
      return { ran: true, result };
    } finally {
      this.running = false;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}
