<<<<<<< Updated upstream
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SimpleCache } from '../src/cache';

describe('SimpleCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('get/set', () => {
    it('returns undefined for a key that was never set', () => {
      const cache = new SimpleCache();
      expect(cache.get('missing')).toBeUndefined();
    });

    it('returns a fresh (non-stale) value right after set', () => {
      const cache = new SimpleCache();
      cache.set('key', { foo: 'bar' }, 1_000);

      expect(cache.get('key')).toEqual({ value: { foo: 'bar' }, stale: false });
    });

    it('overwrites an existing value for the same key', () => {
      const cache = new SimpleCache();
      cache.set('key', 'first', 1_000);
      cache.set('key', 'second', 1_000);

      expect(cache.get('key')).toEqual({ value: 'second', stale: false });
    });
  });

  describe('invalidate', () => {
    it('removes a single entry', () => {
      const cache = new SimpleCache();
      cache.set('a', 1, 1_000);
      cache.set('b', 2, 1_000);

      cache.invalidate('a');

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toEqual({ value: 2, stale: false });
    });

    it('is a no-op for a key that is not present', () => {
      const cache = new SimpleCache();
      expect(() => cache.invalidate('missing')).not.toThrow();
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const cache = new SimpleCache();
      cache.set('a', 1, 1_000);
      cache.set('b', 2, 1_000);

      cache.clear();

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
    });
  });

  describe('TTL expiry', () => {
    it('expires an entry once its TTL elapses when stale-while-revalidate is off', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      const cache = new SimpleCache();
      cache.set('key', 'value', 100);

      vi.setSystemTime(50);
      expect(cache.get('key')).toEqual({ value: 'value', stale: false });

      vi.setSystemTime(101);
      expect(cache.get('key')).toBeUndefined();
    });

    it('marks an entry stale (but still returns it) within the stale-while-revalidate window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      const cache = new SimpleCache();
      cache.set('key', 'value', 100, true);

      // Past the TTL, but within the 2x stale window.
      vi.setSystemTime(150);
      expect(cache.get('key')).toEqual({ value: 'value', stale: true });
    });

    it('fully expires an entry once the stale-while-revalidate window elapses', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      const cache = new SimpleCache();
      cache.set('key', 'value', 100, true);

      // Past both the TTL and the 2x stale window.
      vi.setSystemTime(201);
      expect(cache.get('key')).toBeUndefined();
    });
  });

  describe('eviction', () => {
    it('evicts the oldest entry once maxEntries is exceeded', () => {
      const cache = new SimpleCache({ maxEntries: 2 });
      cache.set('a', 1, 1_000);
      cache.set('b', 2, 1_000);
      cache.set('c', 3, 1_000);

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toEqual({ value: 2, stale: false });
      expect(cache.get('c')).toEqual({ value: 3, stale: false });
    });

    it('does not evict when updating an existing key', () => {
      const cache = new SimpleCache({ maxEntries: 2 });
      cache.set('a', 1, 1_000);
      cache.set('b', 2, 1_000);
      cache.set('a', 'updated', 1_000);

      expect(cache.get('a')).toEqual({ value: 'updated', stale: false });
      expect(cache.get('b')).toEqual({ value: 2, stale: false });
    });

    it('defaults maxEntries to 100', () => {
      const cache = new SimpleCache();
      for (let i = 0; i < 100; i++) {
        cache.set(`key-${i}`, i, 1_000);
      }
      // The 101st distinct key should evict the oldest ("key-0").
      cache.set('key-100', 100, 1_000);

      expect(cache.get('key-0')).toBeUndefined();
      expect(cache.get('key-100')).toEqual({ value: 100, stale: false });
    });
=======
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SimpleCache } from '../src/cache';

const LONG_TTL = 60_000;

describe('SimpleCache LRU eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps a frequently-read key alive under insertion pressure', () => {
    const cache = new SimpleCache({ maxEntries: 3 });

    cache.set('A', 'a', LONG_TTL);
    cache.set('B', 'b', LONG_TTL);
    cache.set('C', 'c', LONG_TTL);

    // Keep reading A while inserting fresh keys to force evictions.
    for (let i = 0; i < 10; i++) {
      expect(cache.get<string>('A')?.value).toBe('a');
      cache.set(`X${i}`, `x${i}`, LONG_TTL);
    }

    // A was the most-recently read key on every iteration, so it must survive.
    // The other original keys (B, C) were never touched and should be evicted.
    expect(cache.get<string>('A')?.value).toBe('a');

    const survivors = ['B', 'C'].filter((k) => cache.get<string>(k) !== undefined);
    expect(survivors.length).toBeLessThan(2);
  });

  it('refreshes LRU position even for a stale-but-not-expired read', () => {
    const cache = new SimpleCache({ maxEntries: 3 });
    cache.set('A', 'a', LONG_TTL, true); // staleWhileRevalidate → staleUntil = 2*ttl
    cache.set('B', 'b', LONG_TTL);
    cache.set('C', 'c', LONG_TTL);

    // Advance past expiresAt but before staleUntil: get('A') returns stale:true,
    // and should still count as a "use" for LRU purposes.
    vi.setSystemTime(LONG_TTL + 1);
    const staleRead = cache.get<string>('A');
    expect(staleRead?.value).toBe('a');
    expect(staleRead?.stale).toBe(true);

    // Force an eviction. The stale-but-recently-read A must survive; B or C
    // (whichever is oldest by now) should be evicted instead.
    cache.set('D', 'd', LONG_TTL);
    expect(cache.get<string>('A')?.value).toBe('a');
  });

  it('treats overwriting an existing key as a use', () => {
    const cache = new SimpleCache({ maxEntries: 3 });
    cache.set('A', 'a', LONG_TTL);
    cache.set('B', 'b', LONG_TTL);
    cache.set('C', 'c', LONG_TTL);

    // Overwrite A. Under LRU, A is now the most-recently used key.
    cache.set('A', 'a2', LONG_TTL);

    // Insert a fresh key to force exactly one eviction. A must survive.
    cache.set('D', 'd', LONG_TTL);
    expect(cache.get<string>('A')?.value).toBe('a2');

    // Sanity: exactly one of the untouched original keys was evicted.
    const untouched = ['B', 'C'].filter((k) => cache.get<string>(k) !== undefined);
    expect(untouched.length).toBe(1);
  });

  it('does not evict an unrelated entry when overwriting at capacity', () => {
    const cache = new SimpleCache({ maxEntries: 2 });
    cache.set('A', 'a', LONG_TTL);
    cache.set('B', 'b', LONG_TTL);

    // Overwrite A while the cache is full. Neither A nor B should be missing.
    cache.set('A', 'a2', LONG_TTL);

    expect(cache.get<string>('A')?.value).toBe('a2');
    expect(cache.get<string>('B')?.value).toBe('b');
  });

  it('still evicts expired entries without reinserting them', () => {
    const cache = new SimpleCache({ maxEntries: 2 });
    cache.set('A', 'a', 100);
    cache.set('B', 'b', LONG_TTL);

    vi.setSystemTime(101);
    // Reading an expired entry should evict it, not refresh it.
    expect(cache.get<string>('A')).toBeUndefined();

    // A is gone; B remains; inserting C and D must not have to compete with A.
    cache.set('C', 'c', LONG_TTL);
    cache.set('D', 'd', LONG_TTL);
    expect(cache.get<string>('B')?.value).toBe('b');
    expect(cache.get<string>('C')?.value).toBe('c');
    expect(cache.get<string>('D')?.value).toBe('d');
>>>>>>> Stashed changes
  });
});
