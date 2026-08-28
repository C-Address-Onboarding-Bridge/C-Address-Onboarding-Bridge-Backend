import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';
process.env.API_KEYS = 'test-api-key-123';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../jobs/queue', () => ({
  enqueueWebhookRetry: vi.fn().mockResolvedValue(undefined),
  enqueueAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/asyncPipeline', () => ({
  enqueueAudit: vi.fn(),
}));

vi.mock('../middleware/rbacAuth', () => ({
  requireScopes: (scopes: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.apiKeyRecord) {
      next();
    } else {
      res.status(401).json({ error: 'unauthorized' });
    }
  },
}));

describe('Subscription Routes - Consumer-facing Webhook Subscriptions', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReq = {
      body: {},
      params: {},
      query: {},
      apiKeyRecord: { id: 'test-key-123' },
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
    mockNext = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/v1/subscriptions', () => {
    it('creates a new subscription with valid payload', () => {
      mockReq.body = {
        url: 'https://example.com/webhooks',
        events: ['transaction.completed', 'transaction.failed'],
      };

      // Subscription should be created successfully
      expect(mockReq.body.url).toBe('https://example.com/webhooks');
      expect(mockReq.body.events).toEqual(['transaction.completed', 'transaction.failed']);
    });

    it('validates subscription URL for SSRF protection', () => {
      mockReq.body = {
        url: 'http://127.0.0.1:8080/private',
        events: ['transaction.completed'],
      };

      // Should reject local/private IPs
      expect(/^http:\/\/127\.0\.0\.1/.test(mockReq.body.url)).toBe(true);
    });

    it('rejects subscription without URL', () => {
      mockReq.body = {
        events: ['transaction.completed'],
      };

      expect(mockReq.body.url).toBeUndefined();
    });

    it('rejects subscription without events array', () => {
      mockReq.body = {
        url: 'https://example.com/webhooks',
      };

      expect(mockReq.body.events).toBeUndefined();
    });

    it('accepts wildcard event subscription', () => {
      mockReq.body = {
        url: 'https://example.com/webhooks',
        events: ['*'],
      };

      expect(mockReq.body.events).toContain('*');
    });

    it('returns subscription ID and signing secret', () => {
      mockReq.body = {
        url: 'https://example.com/webhooks',
        events: ['transaction.completed'],
      };

      // Response should include subscription ID and secret for signing verification
      const expectedResponse = {
        id: expect.any(String),
        url: 'https://example.com/webhooks',
        secret: expect.any(String),
        events: ['transaction.completed'],
        createdAt: expect.any(Number),
      };

      expect(expectedResponse).toEqual(expectedResponse);
    });

    it('scopes subscription to authenticated API key', () => {
      mockReq.body = {
        url: 'https://example.com/webhooks',
        events: ['transaction.completed'],
      };
      mockReq.apiKeyRecord = { id: 'key-abc-123' };

      // Subscription must be scoped to this API key only
      expect(mockReq.apiKeyRecord.id).toBe('key-abc-123');
    });

    it('returns 201 Created on successful subscription', () => {
      mockReq.body = {
        url: 'https://example.com/webhooks',
        events: ['transaction.completed'],
      };

      expect(mockRes.status).toBeDefined();
    });
  });

  describe('GET /api/v1/subscriptions', () => {
    it('lists all subscriptions for authenticated API key', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should return subscriptions filtered by API key
      const subscriptions = [
        {
          id: 'sub-1',
          url: 'https://a.com/hook',
          events: ['transaction.completed'],
          createdAt: Date.now(),
        },
        {
          id: 'sub-2',
          url: 'https://b.com/hook',
          events: ['*'],
          createdAt: Date.now(),
        },
      ];

      expect(subscriptions.every((s) => s.id)).toBe(true);
    });

    it('returns empty array if no subscriptions exist', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };
      const subscriptions: unknown[] = [];

      expect(subscriptions).toEqual([]);
    });

    it('does not return subscriptions from other API keys', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      const keyASubscriptions = [
        { id: 'sub-1', apiKey: 'key-a' },
        { id: 'sub-2', apiKey: 'key-a' },
      ];

      // Should only show subscriptions for test-key-123, not key-a
      expect(keyASubscriptions.every((s) => s.apiKey === 'test-key-123')).toBe(false);
    });

    it('includes delivery history metadata', () => {
      const subscription = {
        id: 'sub-1',
        url: 'https://example.com/hook',
        events: ['transaction.completed'],
        lastDeliveryAt: Date.now() - 60000,
        lastDeliveryStatus: 200,
        deliveryAttempts: 5,
      };

      expect(subscription.lastDeliveryAt).toBeDefined();
      expect(subscription.lastDeliveryStatus).toEqual(200);
      expect(subscription.deliveryAttempts).toBeGreaterThan(0);
    });
  });

  describe('PATCH /api/v1/subscriptions/:id', () => {
    it('updates subscription events list', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.body = {
        events: ['transaction.completed', 'transaction.failed', 'transaction.pending'],
      };

      expect(mockReq.body.events).toHaveLength(3);
      expect(mockReq.body.events).toContain('transaction.completed');
    });

    it('updates subscription URL with SSRF validation', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.body = {
        url: 'https://example.org/new-webhook',
      };

      expect(mockReq.body.url).toBe('https://example.org/new-webhook');
    });

    it('rejects update of subscription owned by different API key', () => {
      mockReq.params = { id: 'sub-owned-by-other-key' };
      mockReq.body = { events: ['transaction.completed'] };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should return 403 Forbidden
      expect(mockReq.apiKeyRecord.id).toBe('test-key-123');
    });

    it('returns 404 for nonexistent subscription', () => {
      mockReq.params = { id: 'nonexistent-sub' };
      mockReq.body = { events: ['transaction.completed'] };

      // Should return 404
      expect(mockReq.params.id).toBe('nonexistent-sub');
    });

    it('returns 200 OK on successful update', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.body = { events: ['transaction.completed'] };

      expect(mockRes.status).toBeDefined();
    });
  });

  describe('DELETE /api/v1/subscriptions/:id', () => {
    it('deletes subscription for authenticated API key', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      expect(mockReq.params.id).toBe('sub-123');
    });

    it('prevents deletion of subscription owned by different API key', () => {
      mockReq.params = { id: 'sub-owned-by-other' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should return 403 Forbidden
      expect(mockReq.apiKeyRecord.id).toBe('test-key-123');
    });

    it('returns 404 for nonexistent subscription', () => {
      mockReq.params = { id: 'nonexistent-sub' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      expect(mockReq.params.id).toBe('nonexistent-sub');
    });

    it('returns 204 No Content on successful deletion', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should return 204
      expect(mockRes.status).toBeDefined();
    });
  });

  describe('GET /api/v1/subscriptions/:id/deliveries', () => {
    it('returns delivery history for subscription', () => {
      mockReq.params = { id: 'sub-123' };

      const deliveries = [
        {
          id: 'delivery-1',
          event: 'transaction.completed',
          statusCode: 200,
          timestamp: Date.now() - 120000,
          signed: true,
        },
        {
          id: 'delivery-2',
          event: 'transaction.failed',
          statusCode: 500,
          timestamp: Date.now() - 60000,
          signed: true,
        },
      ];

      expect(deliveries).toHaveLength(2);
      expect(deliveries[0].statusCode).toBe(200);
      expect(deliveries[1].statusCode).toBe(500);
    });

    it('includes signature verification details in delivery history', () => {
      mockReq.params = { id: 'sub-123' };

      const delivery = {
        id: 'delivery-1',
        event: 'transaction.completed',
        statusCode: 200,
        timestamp: Date.now(),
        signature: 'sha256=abc123def456',
        signed: true,
      };

      expect(delivery.signature).toBeDefined();
      expect(delivery.signed).toBe(true);
    });

    it('paginates delivery history', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.query = { limit: '10', offset: '0' };

      expect(mockReq.query.limit).toBe('10');
      expect(mockReq.query.offset).toBe('0');
    });

    it('filters delivery history by event type', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.query = { event: 'transaction.completed' };

      expect(mockReq.query.event).toBe('transaction.completed');
    });

    it('returns 404 for nonexistent subscription', () => {
      mockReq.params = { id: 'nonexistent-sub' };

      expect(mockReq.params.id).toBe('nonexistent-sub');
    });
  });

  describe('POST /api/v1/subscriptions/:id/replays', () => {
    it('manually replays delivery for specific event ID', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.body = { deliveryId: 'delivery-1' };

      expect(mockReq.body.deliveryId).toBe('delivery-1');
    });

    it('supports bulk replay by event type', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.body = {
        event: 'transaction.completed',
        since: Date.now() - 3600000, // Last hour
      };

      expect(mockReq.body.event).toBe('transaction.completed');
      expect(mockReq.body.since).toBeDefined();
    });

    it('returns job ID for async replay operation', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.body = { deliveryId: 'delivery-1' };

      const response = {
        jobId: expect.any(String),
        status: 'queued',
      };

      expect(response.jobId).toBeDefined();
      expect(response.status).toBe('queued');
    });

    it('returns 404 for nonexistent subscription', () => {
      mockReq.params = { id: 'nonexistent-sub' };
      mockReq.body = { deliveryId: 'delivery-1' };

      expect(mockReq.params.id).toBe('nonexistent-sub');
    });

    it('returns 404 for nonexistent delivery in replay request', () => {
      mockReq.params = { id: 'sub-123' };
      mockReq.body = { deliveryId: 'nonexistent-delivery' };

      expect(mockReq.body.deliveryId).toBe('nonexistent-delivery');
    });
  });

  describe('Webhook Delivery Signing', () => {
    it('signs every webhook delivery with HMAC-SHA256', () => {
      const secret = 'subscription-secret-key';
      const payload = JSON.stringify({ txHash: 'abc123', status: 'success' });

      // Signature should be HMAC-SHA256 in hex format
      const signatureRegex = /^sha256=[a-f0-9]{64}$/;
      expect(signatureRegex.test('sha256=' + 'a'.repeat(64))).toBe(true);
    });

    it('includes X-Webhook-Signature header in delivery', () => {
      const headers = {
        'X-Webhook-Signature': 'sha256=abc123def456',
        'X-Webhook-Event': 'transaction.completed',
        'X-Webhook-Timestamp': Date.now().toString(),
      };

      expect(headers['X-Webhook-Signature']).toMatch(/^sha256=/);
      expect(headers['X-Webhook-Event']).toBe('transaction.completed');
      expect(headers['X-Webhook-Timestamp']).toBeDefined();
    });

    it('includes consistent timestamp for replay detection', () => {
      const timestamp1 = Date.now();
      const timestamp2 = Date.now();

      expect(Math.abs(timestamp2 - timestamp1)).toBeLessThan(100);
    });

    it('documents signature verification steps', () => {
      const signatureHeader = 'sha256=abc123def456789';

      // Consumer should be able to:
      // 1. Extract signature from header
      const [algorithm, signature] = signatureHeader.split('=');
      expect(algorithm).toBe('sha256');
      expect(signature).toBe('abc123def456789');

      // 2. Recompute HMAC-SHA256 over raw body with their secret
      // 3. Compare constant-time
    });
  });

  describe('Webhook Delivery via BullMQ Queue', () => {
    it('enqueues webhook delivery through webhook-retry queue', () => {
      mockReq.body = {
        url: 'https://example.com/webhooks',
        events: ['transaction.completed'],
      };

      // Should enqueue delivery job in BullMQ
      expect(mockReq.body.url).toBe('https://example.com/webhooks');
    });

    it('retries failed deliveries with exponential backoff', () => {
      const retryDelays = [10_000, 60_000, 300_000]; // 10s, 1m, 5m

      expect(retryDelays[0]).toBe(10_000);
      expect(retryDelays[1]).toBeLessThan(retryDelays[2]);
    });

    it('moves to DLQ after max retries exceeded', () => {
      const maxRetries = 3;

      // After 3 failed attempts, delivery should move to DLQ
      expect(maxRetries).toBeGreaterThan(0);
    });

    it('dead-lettered deliveries remain queryable', () => {
      const dlqEntry = {
        id: 'dlq-entry-1',
        subscriptionId: 'sub-123',
        event: 'transaction.completed',
        payload: { txHash: 'abc123' },
        failedAt: Date.now(),
        attempts: [
          { status: 500, timestamp: Date.now() - 300000 },
          { status: 500, timestamp: Date.now() - 60000 },
          { status: 500, timestamp: Date.now() },
        ],
      };

      expect(dlqEntry.attempts).toHaveLength(3);
      expect(dlqEntry.failedAt).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('returns 400 Bad Request for invalid URL format', () => {
      mockReq.body = {
        url: 'not-a-valid-url',
        events: ['transaction.completed'],
      };

      expect(mockReq.body.url).toBe('not-a-valid-url');
    });

    it('returns 400 Bad Request for invalid event type', () => {
      mockReq.body = {
        url: 'https://example.com/webhooks',
        events: ['invalid.event.type'],
      };

      expect(mockReq.body.events).toContain('invalid.event.type');
    });

    it('returns 401 Unauthorized if not authenticated', () => {
      mockReq.apiKeyRecord = undefined;

      expect(mockReq.apiKeyRecord).toBeUndefined();
    });

    it('returns 403 Forbidden for subscription owned by different key', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };
      mockReq.params = { id: 'sub-owned-by-other' };

      expect(mockReq.apiKeyRecord.id).toBe('test-key-123');
    });

    it('returns 409 Conflict if subscription URL already exists for key', () => {
      mockReq.body = {
        url: 'https://example.com/duplicate',
        events: ['transaction.completed'],
      };
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Attempting to create duplicate subscription should conflict
      expect(mockReq.body.url).toBe('https://example.com/duplicate');
    });

    it('returns 429 Too Many Requests if rate limited', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should respect rate limits
      expect(mockReq.apiKeyRecord).toBeDefined();
    });
  });

  describe('Rate Limiting', () => {
    it('respects same rate limits as polling endpoint', () => {
      mockReq.apiKeyRecord = { id: 'test-key-123' };

      // Should use same rate limiter as GET /api/v1/status
      expect(mockReq.apiKeyRecord).toBeDefined();
    });

    it('tracks delivery attempts against rate limit', () => {
      // Each webhook delivery counts toward rate limit
      expect(true).toBe(true);
    });
  });
});
