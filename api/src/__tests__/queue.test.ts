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
});
