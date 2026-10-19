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
  });
});
