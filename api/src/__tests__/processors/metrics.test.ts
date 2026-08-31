import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { processMetrics, recordMetric, getMetrics } from '../../jobs/processors/metrics';

process.env.NODE_ENV = 'test';

vi.mock('pino', () => ({
  default: () => ({
    info: vi.fn(),
  }),
}));

describe('Metrics Processor', () => {
  let mockJob: Partial<Job>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear metrics store before each test by processing with reset
    mockJob = {
      data: {
        period: 'hourly' as const,
      },
    };
  });

  describe('recordMetric', () => {
    it('increments txSubmitted counter', async () => {
      recordMetric('txSubmitted');
      recordMetric('txSubmitted');

      await processMetrics(mockJob as Job);
      const snapshots = getMetrics();
      const latest = snapshots[snapshots.length - 1];

      expect(latest.txSubmitted).toBe(2);
    });

    it('increments txSuccess counter', async () => {
      recordMetric('txSuccess');
      recordMetric('txSuccess');
      recordMetric('txSuccess');

      await processMetrics(mockJob as Job);
      const snapshots = getMetrics();
      const latest = snapshots[snapshots.length - 1];

      expect(latest.txSuccess).toBe(3);
    });

    it('increments txFailed counter', async () => {
      recordMetric('txFailed');
      recordMetric('txFailed');

      await processMetrics(mockJob as Job);
      const snapshots = getMetrics();
      const latest = snapshots[snapshots.length - 1];

      expect(latest.txFailed).toBe(2);
    });

    it('increments webhooksDelivered counter', async () => {
      recordMetric('webhooksDelivered');
      recordMetric('webhooksDelivered');
      recordMetric('webhooksDelivered');
      recordMetric('webhooksDelivered');

      await processMetrics(mockJob as Job);
      const snapshots = getMetrics();
      const latest = snapshots[snapshots.length - 1];

      expect(latest.webhooksDelivered).toBe(4);
    });

    it('tracks multiple metrics simultaneously', async () => {
      recordMetric('txSubmitted');
      recordMetric('txSuccess');
      recordMetric('txFailed');
      recordMetric('webhooksDelivered');
      recordMetric('webhooksDelivered');

      await processMetrics(mockJob as Job);
      const snapshots = getMetrics();
      const latest = snapshots[snapshots.length - 1];

      expect(latest.txSubmitted).toBe(1);
      expect(latest.txSuccess).toBe(1);
      expect(latest.txFailed).toBe(1);
      expect(latest.webhooksDelivered).toBe(2);
    });
  });

  describe('processMetrics', () => {
    it('creates a snapshot with hourly period', async () => {
      recordMetric('txSubmitted');

      mockJob.data = { period: 'hourly' as const };
      await processMetrics(mockJob as Job);

      const snapshots = getMetrics();
      const latest = snapshots[snapshots.length - 1];

      expect(latest.period).toBe('hourly');
      expect(latest.computedAt).toBeDefined();
      expect(typeof latest.computedAt).toBe('number');
    });

    it('creates a snapshot with daily period', async () => {
      recordMetric('txSubmitted');

      mockJob.data = { period: 'daily' as const };
      await processMetrics(mockJob as Job);

      const snapshots = getMetrics();
      const latest = snapshots[snapshots.length - 1];

      expect(latest.period).toBe('daily');
    });

    it('resets counters after snapshot', async () => {
      recordMetric('txSubmitted');
      await processMetrics(mockJob as Job);

      // Record more metrics
      recordMetric('txSuccess');

      // Process again without recording more txSubmitted
      await processMetrics(mockJob as Job);

      const snapshots = getMetrics();
      const lastSnapshot = snapshots[snapshots.length - 1];

      expect(lastSnapshot.txSubmitted).toBe(0);
      expect(lastSnapshot.txSuccess).toBe(1);
    });

    it('maintains historical snapshots', async () => {
      recordMetric('txSubmitted');
      const beforeLength = getMetrics().length;

      await processMetrics(mockJob as Job);

      const snapshots = getMetrics();
      expect(snapshots.length).toBe(beforeLength + 1);
    });

    it('sets computedAt timestamp', async () => {
      const beforeTime = Date.now();

      recordMetric('txSubmitted');
      await processMetrics(mockJob as Job);

      const snapshots = getMetrics();
      const latest = snapshots[snapshots.length - 1];
      const afterTime = Date.now();

      expect(latest.computedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(latest.computedAt).toBeLessThanOrEqual(afterTime);
    });

    it('handles zero metrics', async () => {
      // Don't record any metrics, just process
      await processMetrics(mockJob as Job);

      const snapshots = getMetrics();
      const latest = snapshots[snapshots.length - 1];

      expect(latest.txSubmitted).toBe(0);
      expect(latest.txSuccess).toBe(0);
      expect(latest.txFailed).toBe(0);
      expect(latest.webhooksDelivered).toBe(0);
    });

    it('accumulates metrics across multiple jobs', async () => {
      recordMetric('txSubmitted');
      recordMetric('txSubmitted');
      await processMetrics(mockJob as Job);

      recordMetric('txSubmitted');
      await processMetrics(mockJob as Job);

      const snapshots = getMetrics();
      expect(snapshots[snapshots.length - 2].txSubmitted).toBe(2);
      expect(snapshots[snapshots.length - 1].txSubmitted).toBe(1);
    });
  });

  describe('getMetrics', () => {
    it('returns array of snapshots', async () => {
      recordMetric('txSubmitted');
      await processMetrics(mockJob as Job);

      const metrics = getMetrics();
      expect(Array.isArray(metrics)).toBe(true);
    });

    it('includes all snapshot fields', async () => {
      recordMetric('txSubmitted');
      await processMetrics(mockJob as Job);

      const snapshots = getMetrics();
      const snapshot = snapshots[snapshots.length - 1];

      expect(snapshot).toHaveProperty('period');
      expect(snapshot).toHaveProperty('computedAt');
      expect(snapshot).toHaveProperty('txSubmitted');
      expect(snapshot).toHaveProperty('txSuccess');
      expect(snapshot).toHaveProperty('txFailed');
      expect(snapshot).toHaveProperty('webhooksDelivered');
    });
  });
});
