import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Redis from 'ioredis';
import { RedisRateLimitStore } from '../middleware/redisRateLimitStore';

process.env.NODE_ENV = 'test';

// Mock the config module
vi.mock('../config', () => ({
  config: {
    rateLimit: { redisEnabled: true },
    redis: { url: 'redis://localhost:6379' },
  },
}));

// Create a mock Redis instance for use in tests
function createMockRedis(): any {
  return {
    on: vi.fn().mockReturnThis(),
    multi: vi.fn(),
    incr: vi.fn(),
    decr: vi.fn(),
    del: vi.fn(),
    expire: vi.fn(),
    pttl: vi.fn(),
  };
}

let mockRedis: ReturnType<typeof createMockRedis>;

// Mock ioredis module - return mockRedis instance 
vi.mock('ioredis', () => {
  return {
    default: vi.fn(function (this: any) {
      // This will be called when the module is first loaded
      // We need to return a mock that the code can use
      return new Proxy(mockRedis || createMockRedis(), {
        get: (target, prop) => {
          // Ensure mockRedis exists and is fresh
          if (!mockRedis) {
            mockRedis = createMockRedis();
          }
          return mockRedis[prop as string];
        },
      });
    }),
  };
});

describe('RedisRateLimitStore', () => {
  let store: RedisRateLimitStore;

  beforeEach(() => {
    // Reset and create fresh mock for each test
    mockRedis = createMockRedis();
    vi.clearAllMocks();
    
    store = new RedisRateLimitStore('test-prefix');
    store.init({ windowMs: 60000 } as any);
  });

  describe('initialization', () => {
    it('creates store with prefix', () => {
      const testStore = new RedisRateLimitStore('my-api');
      expect(testStore.prefix).toBe('my-api');
    });

    it('sets windowMs during init', () => {
      const testStore = new RedisRateLimitStore('test');
      testStore.init({ windowMs: 30000 } as any);
      expect(testStore.windowMs).toBe(30000);
    });

    it('constructs redis key with prefix', () => {
      const testStore = new RedisRateLimitStore('api');
      expect((testStore as any).redisPrefix).toBe('rl:api:');
    });
  });

  describe('increment', () => {
    it('increments counter in redis and returns updated count', async () => {
      const pipelineObj = {
        incr: vi.fn().mockReturnValue({}),
        pttl: vi.fn().mockReturnValue({}),
        exec: vi.fn().mockResolvedValue([
          [null, 5],
          [null, 45000],
        ]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const result = await store.increment('user:123');

      expect(result.totalHits).toBe(5);
      expect(result.resetTime).toBeInstanceOf(Date);
      expect(result.resetTime.getTime()).toBeGreaterThan(Date.now());
    });

    it('uses windowMs as TTL when pttl returns -1', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 1], [null, -1]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);
      mockRedis!.expire = vi.fn().mockResolvedValue(1);

      const result = await store.increment('user:456');

      expect(result.totalHits).toBe(1);
      expect(mockRedis!.expire).toHaveBeenCalledWith('rl:test-prefix:user:456', 60);
      const timeDiff = result.resetTime.getTime() - Date.now();
      expect(timeDiff).toBeGreaterThan(59500);
      expect(timeDiff).toBeLessThanOrEqual(60000);
    });

    it('degrades gracefully when redis pipeline fails', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockRejectedValue(new Error('Redis connection failed')),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const result = await store.increment('user:789');

      expect(result.totalHits).toBe(1);
      expect(result.resetTime).toBeInstanceOf(Date);
      const timeDiff = result.resetTime.getTime() - Date.now();
      expect(timeDiff).toBeGreaterThan(59500);
      expect(timeDiff).toBeLessThanOrEqual(60000);
    });

    it('handles null results from redis pipeline', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, undefined], [null, undefined]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);
      mockRedis!.expire = vi.fn().mockResolvedValue(1);

      const result = await store.increment('user:999');

      expect(result.totalHits).toBe(1);
      expect(mockRedis!.expire).toHaveBeenCalled();
    });

    it('includes windowMs in reset time calculation', async () => {
      const windowMs = 120000;
      store.windowMs = windowMs;

      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 10], [null, 50000]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const beforeTime = Date.now();
      const result = await store.increment('key');
      const afterTime = Date.now();

      const expectedMin = beforeTime + 50000;
      const expectedMax = afterTime + 50000;
      const actualTime = result.resetTime.getTime();

      expect(actualTime).toBeGreaterThanOrEqual(expectedMin - 100);
      expect(actualTime).toBeLessThanOrEqual(expectedMax + 100);
    });

    it('uses correct redis key format with prefix', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 1], [null, -1]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);
      mockRedis!.expire = vi.fn().mockResolvedValue(1);

      await store.increment('test-key');

      expect(mockRedis!.expire).toHaveBeenCalledWith('rl:test-prefix:test-key', expect.any(Number));
    });

    it('handles large hit counts', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 999999], [null, 60000]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const result = await store.increment('popular-endpoint');

      expect(result.totalHits).toBe(999999);
    });

    it('handles TTL very close to expiry', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 1], [null, 1]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const result = await store.increment('expiring-key');

      expect(result.resetTime.getTime() - Date.now()).toBeLessThanOrEqual(100);
    });

    it('returns IncrementResponse with required fields', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 3], [null, 30000]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const result = await store.increment('test');

      expect(result).toHaveProperty('totalHits');
      expect(result).toHaveProperty('resetTime');
      expect(typeof result.totalHits).toBe('number');
      expect(result.resetTime).toBeInstanceOf(Date);
    });
  });

  describe('decrement', () => {
    it('decrements counter in redis', async () => {
      mockRedis!.decr = vi.fn().mockResolvedValue(4);

      await store.decrement('user:123');

      expect(mockRedis!.decr).toHaveBeenCalledWith('rl:test-prefix:user:123');
    });

    it('uses correct redis key format', async () => {
      mockRedis!.decr = vi.fn().mockResolvedValue(0);

      await store.decrement('api-key:456');

      expect(mockRedis!.decr).toHaveBeenCalledWith('rl:test-prefix:api-key:456');
    });

    it('degrades gracefully when redis fails', async () => {
      mockRedis!.decr = vi.fn().mockRejectedValue(new Error('Connection timeout'));

      // Should not throw
      await expect(store.decrement('user:123')).resolves.toBeUndefined();
    });

    it('continues operation even after error', async () => {
      mockRedis!.decr = vi.fn()
        .mockRejectedValueOnce(new Error('First error'))
        .mockResolvedValueOnce(3);

      await store.decrement('user:1');
      await store.decrement('user:2');

      expect(mockRedis!.decr).toHaveBeenCalledTimes(2);
    });

    it('handles keys with special characters', async () => {
      mockRedis!.decr = vi.fn().mockResolvedValue(0);

      await store.decrement('user:123@example.com');

      expect(mockRedis!.decr).toHaveBeenCalledWith('rl:test-prefix:user:123@example.com');
    });
  });

  describe('resetKey', () => {
    it('deletes key from redis', async () => {
      mockRedis!.del = vi.fn().mockResolvedValue(1);

      await store.resetKey('user:123');

      expect(mockRedis!.del).toHaveBeenCalledWith('rl:test-prefix:user:123');
    });

    it('uses correct redis key format', async () => {
      mockRedis!.del = vi.fn().mockResolvedValue(1);

      await store.resetKey('endpoint:v1:post');

      expect(mockRedis!.del).toHaveBeenCalledWith('rl:test-prefix:endpoint:v1:post');
    });

    it('degrades gracefully when redis fails', async () => {
      mockRedis!.del = vi.fn().mockRejectedValue(new Error('Redis unavailable'));

      // Should not throw
      await expect(store.resetKey('user:123')).resolves.toBeUndefined();
    });

    it('handles multiple key deletions', async () => {
      mockRedis!.del = vi.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);

      await store.resetKey('user:1');
      await store.resetKey('user:2');
      await store.resetKey('user:3');

      expect(mockRedis!.del).toHaveBeenCalledTimes(3);
      expect(mockRedis!.del).toHaveBeenNthCalledWith(1, 'rl:test-prefix:user:1');
      expect(mockRedis!.del).toHaveBeenNthCalledWith(2, 'rl:test-prefix:user:2');
      expect(mockRedis!.del).toHaveBeenNthCalledWith(3, 'rl:test-prefix:user:3');
    });

    it('handles non-existent keys gracefully', async () => {
      mockRedis!.del = vi.fn().mockResolvedValue(0);

      await store.resetKey('non-existent');

      expect(mockRedis!.del).toHaveBeenCalled();
    });
  });

  describe('Store interface compliance', () => {
    it('implements Store interface methods', () => {
      expect(typeof store.init).toBe('function');
      expect(typeof store.increment).toBe('function');
      expect(typeof store.decrement).toBe('function');
      expect(typeof store.resetKey).toBe('function');
    });
  });

  describe('concurrent operations', () => {
    it('handles multiple concurrent increments', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn()
          .mockResolvedValueOnce([[null, 1], [null, 60000]])
          .mockResolvedValueOnce([[null, 2], [null, 60000]])
          .mockResolvedValueOnce([[null, 3], [null, 60000]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const results = await Promise.all([
        store.increment('key1'),
        store.increment('key2'),
        store.increment('key3'),
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].totalHits).toBe(1);
      expect(results[1].totalHits).toBe(2);
      expect(results[2].totalHits).toBe(3);
    });

    it('handles mixed operations concurrently', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 5], [null, 60000]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);
      mockRedis!.decr = vi.fn().mockResolvedValue(4);
      mockRedis!.del = vi.fn().mockResolvedValue(1);

      await expect(
        Promise.all([
          store.increment('key1'),
          store.decrement('key2'),
          store.resetKey('key3'),
        ])
      ).resolves.toBeDefined();
      
      expect(mockRedis!.decr).toHaveBeenCalled();
      expect(mockRedis!.del).toHaveBeenCalled();
    });
  });

  describe('windowMs edge cases', () => {
    it('handles very short window (1 second)', async () => {
      store.windowMs = 1000;

      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 1], [null, -1]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);
      mockRedis!.expire = vi.fn().mockResolvedValue(1);

      const result = await store.increment('rapid-key');

      expect(result.totalHits).toBe(1);
      expect(mockRedis!.expire).toHaveBeenCalledWith(expect.any(String), 1);
    });

    it('handles very long window (24 hours)', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      store.windowMs = dayMs;

      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 100], [null, -1]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);
      mockRedis!.expire = vi.fn().mockResolvedValue(1);

      const result = await store.increment('long-window-key');

      expect(result.totalHits).toBe(100);
      expect(mockRedis!.expire).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
      
      const [, ttlSec] = (mockRedis!.expire as any).mock.calls[0];
      expect(ttlSec).toBeGreaterThan(86399);
      expect(ttlSec).toBeLessThanOrEqual(86400);
    });
  });

  describe('error handling and degrade-to-in-memory', () => {
    it('degrade-to-in-memory on increment when redis fails', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockRejectedValue(new Error('Redis down')),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const result = await store.increment('fallback-key');

      // Should return sensible defaults
      expect(result.totalHits).toBe(1);
      expect(result.resetTime).toBeInstanceOf(Date);
      expect(result.resetTime.getTime() - Date.now()).toBeGreaterThan(0);
    });

    it('degrade-to-in-memory on decrement returns gracefully', async () => {
      mockRedis!.decr = vi.fn().mockRejectedValue(new Error('Redis down'));

      // Should not throw and return gracefully
      await expect(store.decrement('fallback-key')).resolves.toBeUndefined();
    });

    it('degrade-to-in-memory on resetKey returns gracefully', async () => {
      mockRedis!.del = vi.fn().mockRejectedValue(new Error('Redis down'));

      // Should not throw and return gracefully
      await expect(store.resetKey('fallback-key')).resolves.toBeUndefined();
    });

    it('recovers after intermittent redis failures', async () => {
      // First call fails
      const pipelineObj1 = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockRejectedValue(new Error('Temporary failure')),
      };
      mockRedis!.multi = vi.fn().mockReturnValueOnce(pipelineObj1);

      const result1 = await store.increment('key1');
      expect(result1.totalHits).toBe(1);

      // Second call succeeds
      const pipelineObj2 = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([[null, 5], [null, 60000]]),
      };
      mockRedis!.multi = vi.fn().mockReturnValueOnce(pipelineObj2);

      const result2 = await store.increment('key2');
      expect(result2.totalHits).toBe(5);
    });
  });

  describe('key format and naming', () => {
    it('handles empty key names', async () => {
      mockRedis!.del = vi.fn().mockResolvedValue(0);

      await store.resetKey('');

      expect(mockRedis!.del).toHaveBeenCalledWith('rl:test-prefix:');
    });

    it('maintains consistency across prefix boundaries', () => {
      const store1 = new RedisRateLimitStore('api1');
      const store2 = new RedisRateLimitStore('api2');

      expect((store1 as any).redisPrefix).toBe('rl:api1:');
      expect((store2 as any).redisPrefix).toBe('rl:api2:');
    });

    it('handles complex nested keys', async () => {
      mockRedis!.decr = vi.fn().mockResolvedValue(0);

      await store.decrement('user:sub-tenant:123:endpoint:v2/posts');

      expect(mockRedis!.decr).toHaveBeenCalledWith('rl:test-prefix:user:sub-tenant:123:endpoint:v2/posts');
    });
  });

  describe('pipeline error handling', () => {
    it('handles partial pipeline results', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue([
          [new Error('incr error'), null],
          [null, undefined],
        ]),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const result = await store.increment('key');

      // Should degrade gracefully and return default
      expect(result.totalHits).toBe(1);
    });

    it('handles exec returning null', async () => {
      const pipelineObj = {
        incr: vi.fn(),
        pttl: vi.fn(),
        exec: vi.fn().mockResolvedValue(null),
      };
      mockRedis!.multi = vi.fn().mockReturnValue(pipelineObj);

      const result = await store.increment('key');

      expect(result.totalHits).toBe(1);
      expect(result.resetTime).toBeInstanceOf(Date);
    });
  });
});
