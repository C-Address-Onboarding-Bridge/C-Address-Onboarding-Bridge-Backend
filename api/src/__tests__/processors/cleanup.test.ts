import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { processCleanup, registerIdempotencyKey, isIdempotencyKeyUsed } from '../../jobs/processors/cleanup';

process.env.NODE_ENV = 'test';

vi.mock('pino', () => ({
  default: () => ({
    info: vi.fn(),
  }),
}));

describe('Cleanup Processor', () => {
  let mockJob: Partial<Job>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJob = {
      data: {
        olderThanMs: 5000, // 5 seconds
      },
    };
  });

  describe('registerIdempotencyKey', () => {
    it('registers a new idempotency key', () => {
      const key = 'test-key-1';
      expect(isIdempotencyKeyUsed(key)).toBe(false);

      registerIdempotencyKey(key);

      expect(isIdempotencyKeyUsed(key)).toBe(true);
    });

    it('can register multiple keys', () => {
      const keys = ['key-1', 'key-2', 'key-3'];

      keys.forEach((key) => registerIdempotencyKey(key));

      keys.forEach((key) => {
        expect(isIdempotencyKeyUsed(key)).toBe(true);
      });
    });

    it('overwrites existing key registration', () => {
      const key = 'duplicate-key';
      registerIdempotencyKey(key);
      const firstCheck = isIdempotencyKeyUsed(key);

      // Register again
      registerIdempotencyKey(key);
      const secondCheck = isIdempotencyKeyUsed(key);

      expect(firstCheck).toBe(true);
      expect(secondCheck).toBe(true);
    });
  });

  describe('processCleanup', () => {
    it('removes keys older than the cutoff', async () => {
      const oldKey = 'old-key-should-be-deleted';
      registerIdempotencyKey(oldKey);

      // Wait for the key to be older than the cutoff
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockJob.data = { olderThanMs: 5 }; // 5ms cutoff
      await processCleanup(mockJob as Job);

      expect(isIdempotencyKeyUsed(oldKey)).toBe(false);
    });

    it('preserves fresh keys below cutoff', async () => {
      const freshKey = 'fresh-key-should-be-kept';
      registerIdempotencyKey(freshKey);

      // Use a very large cutoff to ensure freshness
      mockJob.data = { olderThanMs: 1000 * 60 * 60 * 24 }; // 1 day
      await processCleanup(mockJob as Job);

      expect(isIdempotencyKeyUsed(freshKey)).toBe(true);
    });

    it('cleans up multiple expired keys', async () => {
      const expiredKeys = ['expired-1', 'expired-2', 'expired-3'];
      expiredKeys.forEach((key) => registerIdempotencyKey(key));

      await new Promise((resolve) => setTimeout(resolve, 15));

      mockJob.data = { olderThanMs: 10 }; // 10ms cutoff
      await processCleanup(mockJob as Job);

      expiredKeys.forEach((key) => {
        expect(isIdempotencyKeyUsed(key)).toBe(false);
      });
    });

    it('handles mixed fresh and expired keys', async () => {
      const expiredKey = 'will-expire';
      registerIdempotencyKey(expiredKey);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const freshKey = 'just-registered';
      registerIdempotencyKey(freshKey);

      mockJob.data = { olderThanMs: 10 }; // 10ms cutoff
      await processCleanup(mockJob as Job);

      expect(isIdempotencyKeyUsed(expiredKey)).toBe(false);
      expect(isIdempotencyKeyUsed(freshKey)).toBe(true);
    });

    it('handles zero cutoff (delete all)', async () => {
      registerIdempotencyKey('key-1');
      registerIdempotencyKey('key-2');

      await new Promise((resolve) => setTimeout(resolve, 5));

      mockJob.data = { olderThanMs: 0 }; // Delete everything
      await processCleanup(mockJob as Job);

      expect(isIdempotencyKeyUsed('key-1')).toBe(false);
      expect(isIdempotencyKeyUsed('key-2')).toBe(false);
    });

    it('handles empty key store', async () => {
      // Should not throw when there are no keys
      mockJob.data = { olderThanMs: 1000 };
      await expect(processCleanup(mockJob as Job)).resolves.not.toThrow();
    });

    it('handles large cutoff values', async () => {
      const keys = ['key-1', 'key-2'];
      keys.forEach((key) => registerIdempotencyKey(key));

      // Use an extremely large cutoff (100 years in milliseconds)
      mockJob.data = { olderThanMs: 100 * 365 * 24 * 60 * 60 * 1000 };
      await processCleanup(mockJob as Job);

      keys.forEach((key) => {
        expect(isIdempotencyKeyUsed(key)).toBe(true);
      });
    });
  });
});
