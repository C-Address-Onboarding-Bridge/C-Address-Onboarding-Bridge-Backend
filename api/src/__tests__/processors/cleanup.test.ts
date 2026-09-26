import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { processCleanup, setCleanupRedisClientForTesting } from '../../jobs/processors/cleanup';

process.env.NODE_ENV = 'test';

vi.mock('pino', () => ({
  default: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('Cleanup Processor', () => {
  let mockJob: Partial<Job>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJob = {
      data: {
        olderThanMs: 7 * 24 * 60 * 60 * 1000,
      },
    };
  });

  afterEach(() => {
    setCleanupRedisClientForTesting(undefined);
  });

  describe('processCleanup', () => {
    it('completes gracefully when Redis is unavailable', async () => {
      setCleanupRedisClientForTesting(null);
      const result = await processCleanup(mockJob as Job);
      expect(result).toEqual({ prunedCount: 0 });
    });

    it('prunes orphan idempotency keys with TTL = -1', async () => {
      const deleted: string[] = [];
      const mockRedis = {
        keys: vi.fn().mockResolvedValue(['idempotency:orphan-key-1']),
        ttl: vi.fn().mockResolvedValue(-1),
        del: vi.fn().mockImplementation((key: string) => {
          deleted.push(key);
          return Promise.resolve(1);
        }),
      };

      setCleanupRedisClientForTesting(mockRedis as never);
      const result = await processCleanup(mockJob as Job);
      expect(result.prunedCount).toBe(1);
      expect(deleted).toContain('idempotency:orphan-key-1');
      expect(mockRedis.del).toHaveBeenCalledWith('idempotency:orphan-key-1');
    });

    it('preserves keys that have active TTL', async () => {
      const mockRedis = {
        keys: vi.fn().mockResolvedValue(['idempotency:active-key-1', 'idempotency:active-key-2']),
        ttl: vi.fn().mockResolvedValue(86400),
        del: vi.fn(),
      };

      setCleanupRedisClientForTesting(mockRedis as never);
      const result = await processCleanup(mockJob as Job);
      expect(result.prunedCount).toBe(0);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('correctly handles mixed active and orphan keys', async () => {
      const deleted: string[] = [];
      const mockRedis = {
        keys: vi.fn().mockResolvedValue([
          'idempotency:active-1',
          'idempotency:orphan-1',
          'idempotency:active-2',
          'idempotency:orphan-2',
        ]),
        ttl: vi.fn().mockImplementation((key: string) => {
          if (key.includes('orphan')) return Promise.resolve(-1);
          return Promise.resolve(3600);
        }),
        del: vi.fn().mockImplementation((key: string) => {
          deleted.push(key);
          return Promise.resolve(1);
        }),
      };

      setCleanupRedisClientForTesting(mockRedis as never);
      const result = await processCleanup(mockJob as Job);
      expect(result.prunedCount).toBe(2);
      expect(deleted).toEqual(['idempotency:orphan-1', 'idempotency:orphan-2']);
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });

    it('handles empty Redis keys response', async () => {
      const mockRedis = {
        keys: vi.fn().mockResolvedValue([]),
        ttl: vi.fn(),
        del: vi.fn(),
      };

      setCleanupRedisClientForTesting(mockRedis as never);
      const result = await processCleanup(mockJob as Job);
      expect(result.prunedCount).toBe(0);
      expect(mockRedis.ttl).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('handles Redis error gracefully without throwing', async () => {
      const mockRedis = {
        keys: vi.fn().mockRejectedValue(new Error('Redis connection dropped')),
        ttl: vi.fn(),
        del: vi.fn(),
      };

      setCleanupRedisClientForTesting(mockRedis as never);
      await expect(processCleanup(mockJob as Job)).resolves.toEqual({
        prunedCount: 0,
      });
    });

    it('handles missing job data by using default olderThanMs', async () => {
      setCleanupRedisClientForTesting(null);
      const emptyJob = { data: undefined } as unknown as Job;
      const result = await processCleanup(emptyJob);
      expect(result).toEqual({ prunedCount: 0 });
    });
  });
});
