/**
 * Per-host circuit breaker.
 *
 * When an upstream host stops answering (a timeout, a refused or reset
 * connection, a DNS failure) every later call to it would wait out the same
 * timeout again. A medicine question fans out to several tools that share a
 * host (openFDA label, FAERS, enforcement, Drugs@FDA), so one dead host used to
 * cost the model minutes of waiting before it got any answer. The breaker
 * remembers the failure for a short cooldown and lets later calls fail at once
 * with a clear "source unavailable" error, so the model moves on to another
 * source.
 */
export interface CircuitBreakerOptions {
  /** How long a host stays skipped after it is marked down. */
  openMs: number;
  /** Consecutive 5xx failures (after retries) that mark a host down. */
  serverErrorThreshold?: number;
  now?: () => number;
}

interface HostState {
  openUntil: number;
  serverErrors: number;
  reason?: string;
}

export interface OpenCircuit {
  /** Milliseconds until the host is tried again. */
  remainingMs: number;
  /** Why the host was marked down, e.g. `timed out after 10s`. */
  reason?: string;
}

export class HostCircuitBreaker {
  private readonly hosts = new Map<string, HostState>();
  private readonly openMs: number;
  private readonly serverErrorThreshold: number;
  private readonly now: () => number;

  constructor({ openMs, serverErrorThreshold = 2, now = Date.now }: CircuitBreakerOptions) {
    this.openMs = openMs;
    this.serverErrorThreshold = serverErrorThreshold;
    this.now = now;
  }

  /** Returns the open circuit for a host, or undefined when it may be called. */
  check(host: string): OpenCircuit | undefined {
    if (this.openMs <= 0) {
      return undefined;
    }
    const state = this.hosts.get(host);
    if (state == null || state.openUntil === 0) {
      return undefined;
    }
    const remainingMs = state.openUntil - this.now();
    if (remainingMs <= 0) {
      // Half-open: let the next call through; its outcome decides.
      state.openUntil = 0;
      return undefined;
    }
    return { remainingMs, reason: state.reason };
  }

  /** The host did not answer at all: skip it for the cooldown. */
  recordTransportFailure(host: string, reason: string): void {
    const state = this.state(host);
    state.openUntil = this.now() + this.openMs;
    state.reason = reason;
  }

  /** The host kept answering 5xx after retries. */
  recordServerError(host: string, reason: string): void {
    const state = this.state(host);
    state.serverErrors += 1;
    if (state.serverErrors >= this.serverErrorThreshold) {
      state.openUntil = this.now() + this.openMs;
      state.reason = reason;
    }
  }

  recordSuccess(host: string): void {
    this.hosts.delete(host);
  }

  private state(host: string): HostState {
    let state = this.hosts.get(host);
    if (state == null) {
      state = { openUntil: 0, serverErrors: 0 };
      this.hosts.set(host, state);
    }
    return state;
  }
}
