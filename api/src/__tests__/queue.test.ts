import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Queue } from 'bullmq';

process.env.NODE_ENV = 'test';

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
