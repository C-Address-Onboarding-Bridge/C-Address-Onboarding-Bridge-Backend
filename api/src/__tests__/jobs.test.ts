import { describe, it, expect, vi } from 'vitest';

process.env.NODE_ENV = 'test';

describe('Background Job Processors', () => {
  describe('cleanup processor', () => {
    it('registerIdempotencyKey and isIdempotencyKeyUsed work correctly', async () => {
      const { registerIdempotencyKey, isIdempotencyKeyUsed } = await import('../jobs/processors/cleanup');
      const key = `test-key-${Math.random()}`;
      expect(isIdempotencyKeyUsed(key)).toBe(false);
      registerIdempotencyKey(key);
      expect(isIdempotencyKeyUsed(key)).toBe(true);
    });

    it('processCleanup removes keys older than the cutoff', async () => {
      const { registerIdempotencyKey, isIdempotencyKeyUsed, processCleanup } = await import('../jobs/processors/cleanup');

      const oldKey = `old-key-${Math.random()}`;
      // Register and set the key's used time to 8 days ago via the exported function
      registerIdempotencyKey(oldKey);

      // Use a tiny cutoff (1ms) to guarantee the key is considered old
      const mockJob = { data: { olderThanMs: 1 } };
      // Wait briefly so the key's usedAt is clearly older than 1ms
      await new Promise((r) => setTimeout(r, 10));
      await processCleanup(mockJob as Parameters<typeof processCleanup>[0]);

      expect(isIdempotencyKeyUsed(oldKey)).toBe(false);
    });

    it('processCleanup preserves fresh keys', async () => {
      const { registerIdempotencyKey, isIdempotencyKeyUsed, processCleanup } = await import('../jobs/processors/cleanup');

      const freshKey = `fresh-key-${Math.random()}`;
      registerIdempotencyKey(freshKey);

      // Use a huge cutoff: only keys older than 100 years get cleaned
      const mockJob = { data: { olderThanMs: 100 * 365 * 24 * 60 * 60 * 1000 } };
      await processCleanup(mockJob as Parameters<typeof processCleanup>[0]);

      expect(isIdempotencyKeyUsed(freshKey)).toBe(true);
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

  describe('txStatus processor', () => {
    it('throws when tx is still pending (triggers Bull retry)', async () => {
      const sorobanModule = await import('../services/soroban');
      vi.spyOn(sorobanModule.sorobanService, 'getTransactionStatus').mockResolvedValueOnce({
        status: 'pending',
        hash: 'abc123',
      });

      const { processTxStatusPoll } = await import('../jobs/processors/txStatus');
      const mockJob = { data: { txHash: 'abc123' }, attemptsMade: 0 };

      await expect(
        processTxStatusPoll(mockJob as Parameters<typeof processTxStatusPoll>[0]),
      ).rejects.toThrow('still pending');
    });

    it('resolves when tx is confirmed success', async () => {
      const sorobanModule = await import('../services/soroban');
      vi.spyOn(sorobanModule.sorobanService, 'getTransactionStatus').mockResolvedValueOnce({
        status: 'success',
        hash: 'abc123',
      });

      const { processTxStatusPoll } = await import('../jobs/processors/txStatus');
      const mockJob = { data: { txHash: 'abc123' }, attemptsMade: 0 };

      await expect(
        processTxStatusPoll(mockJob as Parameters<typeof processTxStatusPoll>[0]),
      ).resolves.toBeUndefined();
    });
  });
});
