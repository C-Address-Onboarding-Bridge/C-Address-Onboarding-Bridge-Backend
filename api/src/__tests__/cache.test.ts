/**
 * Cache service and middleware tests.
 *
 * All tests run without a real Redis instance. Redis calls are intercepted via
 * vi.mock so tests remain fast and deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

process.env.NODE_ENV = 'test';

// ─── Shared mock state ────────────────────────────────────────────────────────

/** In-memory key→value store that backs the fake Redis client. */
const mockStore: Map<string, { value: string; expiresAt: number }> = new Map();

/**
 * Shared object of mock Redis methods. Because vi.mock is hoisted to the top
 * of the module, we cannot refer to an outer `const` in the factory. Instead,
 * we reference this object through the factory closure via a getter that is
 * resolved after the test module is fully loaded.
 */
const redisMethods = {
  on: vi.fn(),
  get: vi.fn(async (key: string) => {
    const entry = mockStore.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      mockStore.delete(key);
      return null;
    }
    return entry.value;
  }),
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    let ttlMs = Infinity;
    if (args[0] === 'EX') ttlMs = (args[1] as number) * 1000;
    if (args[0] === 'PX') ttlMs = args[1] as number;

    const nxIdx = args.indexOf('NX');
    if (nxIdx !== -1) {
      if (mockStore.has(key)) return null;
    }

    mockStore.set(key, { value, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }),
  del: vi.fn(async (...keys: string[]) => {
    for (const k of keys) mockStore.delete(k);
    return keys.length;
  }),
  unlink: vi.fn(async (...keys: string[]) => {
    for (const k of keys) mockStore.delete(k);
    return keys.length;
  }),
  scanStream: vi.fn((options?: { match?: string; count?: number }) => {
    const pattern = options?.match ?? '*';
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const matched = [...mockStore.keys()].filter((k) => re.test(k));
    const batchSize = options?.count ?? 500;
    const batches: string[][] = [];
    for (let i = 0; i < matched.length; i += batchSize) {
      batches.push(matched.slice(i, i + batchSize));
    }
    return Readable.from(batches);
  }),
  keys: vi.fn(async (pattern: string) => {
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return [...mockStore.keys()].filter((k) => re.test(k));
  }),
  info: vi.fn(async () => 'used_memory:1024\r\nused_memory_human:1.00K\r\n'),
  dbsize: vi.fn(async () => mockStore.size),
};

// The mock factory must use a regular function/class so `new Redis(...)` works.
vi.mock('ioredis', () => {
  return {
    default: function MockRedis() {
      return redisMethods;
    },
  };
});

vi.mock('../config', () => ({
  config: {
    redis: {
      url: 'redis://localhost:6379',
      enabled: true,
      quoteTtlSeconds: 30,
      statusTtlSeconds: 10,
      cexTtlSeconds: 60,
      transactionsTtlSeconds: 5,
    },
  },
}));

// Import after mocks are set up
import {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheDelPattern,
  getCacheMetrics,
  isRedisEnabled,
  buildCacheKey,
  CACHE_TTL,
  CACHE_VERSION,
  swrGet,
  swrSet,
  getOrCompute,
  withSingleFlight,
  SWR_EXTENSION_SECONDS,
} from '../services/cache';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clearStore() {
  mockStore.clear();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildCacheKey', () => {
  it('prefixes with version and namespace', () => {
    const key = buildCacheKey('quote', 'XLM:1000:GABCD');
    expect(key).toBe(`v${CACHE_VERSION}:quote:XLM:1000:GABCD`);
  });

  it('produces different keys for different namespaces', () => {
    expect(buildCacheKey('quote', 'x')).not.toBe(buildCacheKey('status', 'x'));
  });
});

describe('CACHE_TTL constants', () => {
  it('quote TTL is 30s', () => expect(CACHE_TTL.quote).toBe(30));
  it('status TTL is 10s', () => expect(CACHE_TTL.status).toBe(10));
  it('cex TTL is 60s', () => expect(CACHE_TTL.cex).toBe(60));
  it('transactions TTL is 5s', () => expect(CACHE_TTL.transactions).toBe(5));
});

describe('isRedisEnabled', () => {
  it('returns true when REDIS_URL is set', () => {
    expect(isRedisEnabled()).toBe(true);
  });
});

describe('cacheGet / cacheSet', () => {
  beforeEach(clearStore);

  it('returns null for a key that does not exist', async () => {
    expect(await cacheGet('no-such-key')).toBeNull();
  });

  it('stores and retrieves a value', async () => {
    await cacheSet('my-key', 'hello', 60);
    expect(await cacheGet('my-key')).toBe('hello');
  });

  it('tracks hits and misses', async () => {
    const before = getCacheMetrics();
    await cacheGet('missing');
    await cacheSet('present', 'v', 60);
    await cacheGet('present');
    const after = getCacheMetrics();
    expect(after.misses).toBeGreaterThan(before.misses);
    expect(after.hits).toBeGreaterThan(before.hits);
  });
});

describe('cacheDel', () => {
  beforeEach(clearStore);

  it('removes an existing key', async () => {
    await cacheSet('del-key', 'value', 60);
    await cacheDel('del-key');
    expect(await cacheGet('del-key')).toBeNull();
  });

  it('does not throw when key does not exist', async () => {
    await expect(cacheDel('ghost-key')).resolves.toBeUndefined();
  });
});

describe('cacheDelPattern', () => {
  beforeEach(clearStore);

  it('deletes all keys matching a glob pattern using scanStream and unlink', async () => {
    redisMethods.scanStream.mockClear();
    redisMethods.unlink.mockClear();

    await cacheSet('quote:XLM:1', 'a', 60);
    await cacheSet('quote:XLM:2', 'b', 60);
    await cacheSet('status:abc', 'c', 60);

    await cacheDelPattern('quote:*');

    expect(redisMethods.scanStream).toHaveBeenCalledWith({ match: 'quote:*', count: 500 });
    expect(redisMethods.unlink).toHaveBeenCalledWith('quote:XLM:1', 'quote:XLM:2');
    expect(await cacheGet('quote:XLM:1')).toBeNull();
    expect(await cacheGet('quote:XLM:2')).toBeNull();
    expect(await cacheGet('status:abc')).toBe('c');
  });

  it('unlinks keys in batches of 500 when keyspace is large', async () => {
    redisMethods.unlink.mockClear();

    // Populate 1200 matching keys
    for (let i = 0; i < 1200; i++) {
      mockStore.set(`bulk:${i}`, { value: `val-${i}`, expiresAt: Date.now() + 60000 });
    }

    await cacheDelPattern('bulk:*');

    expect(redisMethods.unlink).toHaveBeenCalled();
    for (const call of redisMethods.unlink.mock.calls) {
      expect(call.length).toBeLessThanOrEqual(500);
    }
    expect(mockStore.size).toBe(0);
  });
});

describe('getCacheMetrics', () => {
  it('returns hits, misses, and hitRatio', () => {
    const m = getCacheMetrics();
    expect(m).toHaveProperty('hits');
    expect(m).toHaveProperty('misses');
    expect(m).toHaveProperty('hitRatio');
    expect(m.hitRatio).toBeGreaterThanOrEqual(0);
    expect(m.hitRatio).toBeLessThanOrEqual(1);
  });
});

describe('swrGet / swrSet', () => {
  beforeEach(clearStore);

  it('returns null on miss', async () => {
    expect(await swrGet('k')).toBeNull();
  });

  it('stores and retrieves a value as fresh', async () => {
    await swrSet('k', { foo: 'bar' }, 30);
    const result = await swrGet<{ foo: string }>('k');
    expect(result).not.toBeNull();
    expect(result!.value).toEqual({ foo: 'bar' });
    expect(result!.stale).toBe(false);
  });

  it('marks an entry as stale when expiresAt is in the past', async () => {
    // Manually insert a stale SWR entry into the fake store
    const entry = { value: { data: 'old' }, expiresAt: Date.now() - 1000 };
    mockStore.set('stale-key', { value: JSON.stringify(entry), expiresAt: Date.now() + 60_000 });

    const result = await swrGet<{ data: string }>('stale-key');
    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
    expect(result!.value).toEqual({ data: 'old' });
  });

  it('stores entry with TTL = primaryTtl + SWR_EXTENSION_SECONDS', async () => {
    const key = 'swr-ttl-test';
    const before = Date.now();
    await swrSet(key, 'v', 10);
    const stored = mockStore.get(key);
    const expectedExpiry = before + (10 + SWR_EXTENSION_SECONDS) * 1000;
    expect(stored).toBeDefined();
    // Allow 50ms of clock drift in test environment
    expect(stored!.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 50);
    expect(stored!.expiresAt).toBeLessThanOrEqual(expectedExpiry + 50);
  });
});

describe('withSingleFlight (stampede protection)', () => {
  beforeEach(clearStore);

  it('deduplicates concurrent calls for the same key', async () => {
    let callCount = 0;
    const compute = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return 'result';
    };

    const [a, b, c] = await Promise.all([
      withSingleFlight('same-key', compute),
      withSingleFlight('same-key', compute),
      withSingleFlight('same-key', compute),
    ]);

    expect(a).toBe('result');
    expect(b).toBe('result');
    expect(c).toBe('result');
    // Only one call should have actually run
    expect(callCount).toBe(1);
  });

  it('allows independent calls for different keys', async () => {
    let callCount = 0;
    const compute = async (v: string) => {
      callCount++;
      return v;
    };

    const [a, b] = await Promise.all([
      withSingleFlight('key-a', () => compute('a')),
      withSingleFlight('key-b', () => compute('b')),
    ]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(callCount).toBe(2);
  });

  it('waits and polls for value when Redis lock is not acquired', async () => {
    // Simulate that another instance already holds the lock
    mockStore.set('lock:polled-key', { value: '1', expiresAt: Date.now() + 5000 });

    // The other instance will write the cached value after 60ms and release the lock
    setTimeout(async () => {
      await swrSet('polled-key', { data: 'from-other-instance' }, 30);
      mockStore.delete('lock:polled-key');
    }, 60);

    const compute = vi.fn().mockResolvedValue({ data: 'from-this-instance' });
    const result = await withSingleFlight('polled-key', compute);

    expect(result).toEqual({ data: 'from-other-instance' });
    expect(compute).not.toHaveBeenCalled();
  });
});

describe('getOrCompute', () => {
  beforeEach(clearStore);

  it('calls compute on cache miss and stores the result', async () => {
    const compute = vi.fn().mockResolvedValue({ answer: 42 });
    const result = await getOrCompute('new-key', 30, compute);
    expect(result).toEqual({ answer: 42 });
    expect(compute).toHaveBeenCalledOnce();
    // The value should now be in the cache
    const stored = await swrGet<{ answer: number }>('new-key');
    expect(stored?.value.answer).toBe(42);
  });

  it('returns cached value and does NOT call compute on hit', async () => {
    await swrSet('cached-key', { x: 1 }, 30);
    const compute = vi.fn().mockResolvedValue({ x: 99 });
    const result = await getOrCompute('cached-key', 30, compute);
    expect(result).toEqual({ x: 1 });
    expect(compute).not.toHaveBeenCalled();
  });

  it('returns stale value immediately without blocking on background revalidation', async () => {
    // Insert a stale SWR entry
    const staleEntry = { value: { version: 'old' }, expiresAt: Date.now() - 500 };
    mockStore.set('stale-revalidate', {
      value: JSON.stringify(staleEntry),
      expiresAt: Date.now() + 60_000,
    });

    const compute = vi.fn().mockResolvedValue({ version: 'new' });
    const result = await getOrCompute('stale-revalidate', 30, compute);

    // Should return stale value immediately
    expect(result).toEqual({ version: 'old' });
  });

  it('deduplicates concurrent misses for the same key', async () => {
    let callCount = 0;
    const compute = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      return { count: callCount };
    };

    const [r1, r2] = await Promise.all([
      getOrCompute('concurrent-miss', 30, compute),
      getOrCompute('concurrent-miss', 30, compute),
    ]);

    expect(callCount).toBe(1);
    expect(r1).toEqual({ count: 1 });
    expect(r2).toEqual({ count: 1 });
  });

  it('ensures a miss that overlaps a stale revalidation receives an object, not a JSON string', async () => {
    // 1. Insert a stale SWR entry
    const staleEntry = { value: { user: 'alice', version: 1 }, expiresAt: Date.now() - 1000 };
    mockStore.set('stale-overlap-key', {
      value: JSON.stringify(staleEntry),
      expiresAt: Date.now() + 60_000,
    });

    let resolveRevalidation!: (val: { user: string; version: number }) => void;
    const revalidationPromise = new Promise<{ user: string; version: number }>((resolve) => {
      resolveRevalidation = resolve;
    });

    let computeCount = 0;
    const compute = vi.fn(() => {
      computeCount++;
      return revalidationPromise;
    });

    // 2. Caller 1 gets stale hit and triggers background revalidation via setImmediate
    const result1 = await getOrCompute('stale-overlap-key', 30, compute);
    expect(result1).toEqual({ user: 'alice', version: 1 });

    // Allow setImmediate to run so withSingleFlight revalidation promise is registered in inFlightMap
    await new Promise((r) => setImmediate(r));
    expect(compute).toHaveBeenCalledTimes(1);

    // 3. Entry completely expires / gets deleted in the meantime
    mockStore.delete('stale-overlap-key');

    // 4. Caller 2 has a cache miss while revalidation is in flight and joins withSingleFlight
    const missPromise = getOrCompute('stale-overlap-key', 30, compute);

    // 5. Complete background revalidation
    resolveRevalidation({ user: 'alice', version: 2 });

    const result2 = await missPromise;
    // Must be an object, not stringified JSON!
    expect(typeof result2).toBe('object');
    expect(typeof result2).not.toBe('string');
    expect(result2).toEqual({ user: 'alice', version: 2 });
  });
});

// ─── Graceful error handling ──────────────────────────────────────────────────

describe('cache service graceful degradation', () => {
  beforeEach(clearStore);

  it('cacheGet returns null when Redis.get throws', async () => {
    const originalGet = redisMethods.get;
    redisMethods.get = vi.fn().mockRejectedValue(new Error('connection refused'));
    const result = await cacheGet('any-key');
    expect(result).toBeNull();
    redisMethods.get = originalGet;
  });

  it('cacheSet does not throw when Redis.set throws', async () => {
    const originalSet = redisMethods.set;
    redisMethods.set = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(cacheSet('k', 'v', 10)).resolves.toBeUndefined();
    redisMethods.set = originalSet;
  });
});
