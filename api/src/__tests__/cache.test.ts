import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    redis: { url: '', quoteTtlSeconds: 30, statusTtlSeconds: 10 },
  },
}));

import { cacheGet, cacheSet, cacheDel, getCacheMetrics } from '../services/cache';

describe('cache service (no Redis)', () => {
  it('cacheGet returns null when Redis disabled', async () => {
    const result = await cacheGet('any-key');
    expect(result).toBeNull();
  });

  it('cacheSet is a no-op when Redis disabled', async () => {
    await expect(cacheSet('k', 'v', 30)).resolves.toBeUndefined();
  });

  it('cacheDel is a no-op when Redis disabled', async () => {
    await expect(cacheDel('k')).resolves.toBeUndefined();
  });

  it('getCacheMetrics returns zeroed metrics initially', () => {
    const m = getCacheMetrics();
    expect(m).toHaveProperty('hits');
    expect(m).toHaveProperty('misses');
  });
});
