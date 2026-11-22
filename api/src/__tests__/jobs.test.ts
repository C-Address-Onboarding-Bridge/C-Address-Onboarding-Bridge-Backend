import { describe, it, expect } from 'vitest';

process.env.NODE_ENV = 'test';

describe('Background Job Processors', () => {
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
