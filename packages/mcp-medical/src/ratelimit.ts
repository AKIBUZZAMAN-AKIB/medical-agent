/**
 * Per-host request spacing.
 *
 * The upstreams are free, unauthenticated, and mostly single-institution, so
 * the client is a good citizen: no host ever sees more than one request per
 * `minIntervalMs`, and waiters are released in arrival order.
 */
export class HostRateLimiter {
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly timers = new Map<string, Promise<void>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Resolves once the host is clear for another request. */
  async acquire(host: string, minIntervalMs: number): Promise<void> {
    if (minIntervalMs <= 0) {
      return;
    }
    const previous = this.timers.get(host) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.timers.set(
      host,
      previous.then(() => current),
    );

    await previous;
    const earliest = this.nextAllowedAt.get(host) ?? 0;
    const now = this.now();
    const waitMs = earliest - now;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.nextAllowedAt.set(host, this.now() + minIntervalMs);
    release();
  }

  /** Test seam: the spacing this limiter would apply to a host right now. */
  spacingFor(host: string): number {
    return Math.max(0, (this.nextAllowedAt.get(host) ?? 0) - this.now());
  }
}
