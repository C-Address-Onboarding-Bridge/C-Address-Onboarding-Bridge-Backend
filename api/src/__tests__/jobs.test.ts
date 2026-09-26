import { describe, it, expect } from 'vitest';

process.env.NODE_ENV = 'test';

describe('Background Job Processors', () => {
  describe('cleanup processor', () => {
    it('processCleanup completes gracefully without Redis', async () => {
      const { processCleanup, setCleanupRedisClientForTesting } = await import('../jobs/processors/cleanup');
      setCleanupRedisClientForTesting(null);
      const mockJob = { data: { olderThanMs: 1000 } };
      const result = await processCleanup(mockJob as Parameters<typeof processCleanup>[0]);
      expect(result).toEqual({ prunedCount: 0 });
      setCleanupRedisClientForTesting(undefined);
    });

    it('processCleanup prunes orphan idempotency keys with TTL = -1', async () => {
      const { processCleanup, setCleanupRedisClientForTesting } = await import('../jobs/processors/cleanup');
      const deletedKeys: string[] = [];
      const mockRedis = {
        keys: async () => ['idempotency:orphan-1', 'idempotency:valid-1'],
        ttl: async (key: string) => (key === 'idempotency:orphan-1' ? -1 : 3600),
        del: async (key: string) => {
          deletedKeys.push(key);
          return 1;
        },
      };

      setCleanupRedisClientForTesting(mockRedis as unknown as import('ioredis').default);
      const mockJob = { data: { olderThanMs: 1000 } };
      const result = await processCleanup(mockJob as Parameters<typeof processCleanup>[0]);

      expect(result.prunedCount).toBe(1);
      expect(deletedKeys).toEqual(['idempotency:orphan-1']);
      setCleanupRedisClientForTesting(undefined);
    });
  });

  describe('metrics processor', () => {
    it('processMetrics captures a snapshot and resets counters', async () => {
      const metricsProc = await import('../jobs/processors/metrics');

      metricsProc.recordMetric('txSubmitted');
      metricsProc.recordMetric('txSubmitted');
      metricsProc.recordMetric('txSuccess');

      const before = metricsProc.getMetrics().length;
      const mockJob = { data: { period: 'hourly' as const } };
      await metricsProc.processMetrics(mockJob as Parameters<typeof metricsProc.processMetrics>[0]);

      const snapshots = metricsProc.getMetrics();
      expect(snapshots.length).toBe(before + 1);
      const latest = snapshots[snapshots.length - 1];
      expect(latest.period).toBe('hourly');
      expect(latest.txSubmitted).toBeGreaterThanOrEqual(2);
    });
  });
});
