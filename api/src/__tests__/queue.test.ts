import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Queue } from 'bullmq';

process.env.NODE_ENV = 'test';

// ── #910: scheduleRecurringJobs repeat options ───────────────────────────────
describe('scheduleRecurringJobs — repeat options (#910)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('schedules metrics-compute with repeat.every equal to metricsIntervalMs', async () => {
    const metricsIntervalMs = 7_200_000; // 2 hours
    process.env.JOB_METRICS_INTERVAL_MS = String(metricsIntervalMs);
    process.env.JOB_WARMUP_ASSETS = ''; // no warmup assets

    // Spy on Queue.prototype.add before importing so we capture calls.
    const addSpy = vi.spyOn(Queue.prototype, 'add').mockResolvedValue({} as any);

    // config is cached at module load; reset modules so it picks up the new env var.
    const { scheduleRecurringJobs } = await import('../jobs/queue');
    await scheduleRecurringJobs();

    const metricsCall = addSpy.mock.calls.find(([name]) => name === 'metrics-compute');
    expect(metricsCall, 'metrics-compute was not scheduled').toBeDefined();
    const opts = metricsCall![2] as { repeat?: { every?: number; pattern?: string } };
    expect(opts.repeat?.every).toBe(metricsIntervalMs);
    // Must not use a 6-field cron pattern.
    expect(opts.repeat?.pattern).toBeUndefined();

    addSpy.mockRestore();
    delete process.env.JOB_METRICS_INTERVAL_MS;
    delete process.env.JOB_WARMUP_ASSETS;
  });

  it('skips cache-warmup when JOB_WARMUP_ASSETS is empty', async () => {
    process.env.JOB_WARMUP_ASSETS = '';

    const addSpy = vi.spyOn(Queue.prototype, 'add').mockResolvedValue({} as any);

    const { scheduleRecurringJobs } = await import('../jobs/queue');
    await scheduleRecurringJobs();

    const warmupCall = addSpy.mock.calls.find(([name]) => name === 'cache-warmup');
    expect(warmupCall).toBeUndefined();

    addSpy.mockRestore();
    delete process.env.JOB_WARMUP_ASSETS;
  });

  it('schedules cache-warmup with repeat.every 30000 when assets are configured', async () => {
    process.env.JOB_WARMUP_ASSETS = 'XLM,USDC';

    const addSpy = vi.spyOn(Queue.prototype, 'add').mockResolvedValue({} as any);

    const { scheduleRecurringJobs } = await import('../jobs/queue');
    await scheduleRecurringJobs();

    const warmupCall = addSpy.mock.calls.find(([name]) => name === 'cache-warmup');
    expect(warmupCall, 'cache-warmup was not scheduled').toBeDefined();
    const data = warmupCall![1] as { assets: string[] };
    expect(data.assets).toEqual(['XLM', 'USDC']);
    const opts = warmupCall![2] as { repeat?: { every?: number } };
    expect(opts.repeat?.every).toBe(30_000);

    addSpy.mockRestore();
    delete process.env.JOB_WARMUP_ASSETS;
  });
});

describe('Queue operations', () => {
  describe('enqueueAuditLog', () => {
    it('adds an audit log job to the async-critical queue', async () => {
      const { enqueueAuditLog } = await import('../jobs/queue');
      const mockData = {
        type: 'auth_success',
        payload: { userId: '123' },
        actor: 'user:456',
        triggeredAt: Date.now(),
      };

      await expect(enqueueAuditLog(mockData)).resolves.not.toThrow();
    });

    it('enqueueAuditLog returns a promise', async () => {
      const { enqueueAuditLog } = await import('../jobs/queue');
      const mockData = {
        type: 'transaction_submitted',
        payload: { txId: 'abc123' },
        actor: 'system',
        triggeredAt: Date.now(),
      };

      const result = enqueueAuditLog(mockData);
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  describe('enqueueAnalytics', () => {
    it('adds an analytics job to the async-pipeline queue', async () => {
      const { enqueueAnalytics } = await import('../jobs/queue');
      const mockData = {
        batch: [
          {
            event: 'transaction_success',
            labels: { chain: 'stellar' },
            value: 1,
          },
        ],
      };

      await expect(enqueueAnalytics(mockData)).resolves.not.toThrow();
    });

    it('enqueueAnalytics handles empty batches', async () => {
      const { enqueueAnalytics } = await import('../jobs/queue');
      const mockData = { batch: [] };

      await expect(enqueueAnalytics(mockData)).resolves.not.toThrow();
    });

    it('enqueueAnalytics returns a promise', async () => {
      const { enqueueAnalytics } = await import('../jobs/queue');
      const mockData = {
        batch: [
          {
            event: 'api_request',
            labels: { endpoint: '/quote' },
            value: 1,
          },
        ],
      };

      const result = enqueueAnalytics(mockData);
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  describe('closeQueues', () => {
    it('closes all queues without throwing', async () => {
      const { closeQueues } = await import('../jobs/queue');
      await expect(closeQueues()).resolves.not.toThrow();
    });

    it('closeQueues returns a promise', async () => {
      const { closeQueues } = await import('../jobs/queue');
      const result = closeQueues();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  describe('scheduleRecurringJobs', () => {
    it('schedules recurring jobs without throwing', async () => {
      const { scheduleRecurringJobs } = await import('../jobs/queue');
      await expect(scheduleRecurringJobs()).resolves.not.toThrow();
    });

    it('scheduleRecurringJobs returns a promise', async () => {
      const { scheduleRecurringJobs } = await import('../jobs/queue');
      const result = scheduleRecurringJobs();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  describe('getAllQueues', () => {
    it('returns an array of queues', async () => {
      const { getAllQueues } = await import('../jobs/queue');
      const queues = getAllQueues();
      expect(Array.isArray(queues)).toBe(true);
      expect(queues.length).toBeGreaterThan(0);
      expect(queues.every((q) => q instanceof Queue)).toBe(true);
    });

    it('getAllQueues returns the same queue instances on multiple calls', async () => {
      const { getAllQueues } = await import('../jobs/queue');
      const queues1 = getAllQueues();
      const queues2 = getAllQueues();
      expect(queues1).toBe(queues2);
    });
  });
});

// #1050: with jobs disabled, enqueuing a webhook retry must reject so the
// caller (webhookDelivery.ts) falls through to the DLQ instead of stranding
// the retry in Redis.
describe('enqueueWebhookRetry when jobs disabled (#1050)', () => {
  it('rejects so callers can fall back to the DLQ', async () => {
    const { config } = await import('../config');
    const original = config.jobs.enabled;
    config.jobs.enabled = false;

    try {
      const { enqueueWebhookRetry } = await import('../jobs/queue');
      await expect(
        enqueueWebhookRetry(
          {
            registrationId: 'r1',
            url: 'https://example.com/hook',
            event: 'tx.failed',
            timestamp: Date.now(),
            payload: '{}',
            signature: 'sig',
            data: {},
            attemptNumber: 1,
          },
          10_000,
        ),
      ).rejects.toThrow(/jobs disabled/i);
    } finally {
      config.jobs.enabled = original;
    }
  });
});
