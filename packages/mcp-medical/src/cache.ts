/**
 * Bounded in-memory response cache.
 *
 * Public health APIs are shared infrastructure: a research conversation will
 * re-ask the same drug or gene question repeatedly, and every avoided request
 * is a request we do not spend against someone else's free quota. Entries are
 * keyed by the fully-resolved URL, so parameter order can never collide.
 */
export interface CacheOptions {
  maxEntries: number;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number;
}

interface Entry {
  value: string;
  expiresAt: number;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor({ maxEntries, now }: CacheOptions) {
    this.maxEntries = maxEntries;
    this.now = now ?? Date.now;
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry == null) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    /** Re-insert to keep the hottest key at the end of the insertion order. */
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string, ttlMs: number): void {
    if (ttlMs <= 0) {
      return;
    }
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
