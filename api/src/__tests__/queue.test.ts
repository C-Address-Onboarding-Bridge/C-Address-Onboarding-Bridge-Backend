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
});
