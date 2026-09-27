export interface CacheOptions {
  maxEntries?: number;
  debug?: boolean;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  staleUntil: number;
}

export class SimpleCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries: number;
  private readonly debug: boolean;

  constructor(options: CacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100;
    this.debug = options.debug ?? false;
  }

  get<T>(key: string): { value: T; stale: boolean } | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    const now = Date.now();
    if (entry.expiresAt <= now && entry.staleUntil <= now) {
      this.entries.delete(key);
      if (this.debug) {
        console.debug(`[sdk-cache] expired: ${key}`);
      }
      return undefined;
    }

    // Refresh LRU position: move the entry to the end of the Map so it is
    // the last candidate for eviction. `Map.prototype.set` preserves the
    // insertion position of existing keys, so an explicit delete is required.
    this.entries.delete(key);
    this.entries.set(key, entry);

    const stale = entry.expiresAt <= now;
    if (this.debug) {
      console.debug(`[sdk-cache] ${stale ? 'stale-hit' : 'hit'}: ${key}`);
    }
    return { value: entry.value as T, stale };
  }

  set<T>(key: string, value: T, ttlMs: number, staleWhileRevalidate = false): void {
<<<<<<< Updated upstream
    const isNewKey = !this.entries.has(key);
    if (isNewKey && this.entries.size >= this.maxEntries) {
=======
    // Remove any existing entry first so that:
    //   1) an overwrite moves the key to the most-recent position, and
    //   2) capacity is evaluated after the overwrite, not before — otherwise
    //      setting an existing key at capacity would needlessly evict an
    //      unrelated (still-fresh) entry.
    this.entries.delete(key);

    if (this.entries.size >= this.maxEntries) {
>>>>>>> Stashed changes
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    const now = Date.now();
    this.entries.set(key, {
      value,
      expiresAt: now + ttlMs,
      staleUntil: now + (staleWhileRevalidate ? ttlMs * 2 : 0),
    });
    if (this.debug) {
      console.debug(`[sdk-cache] set: ${key} ttl=${ttlMs}ms`);
    }
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
