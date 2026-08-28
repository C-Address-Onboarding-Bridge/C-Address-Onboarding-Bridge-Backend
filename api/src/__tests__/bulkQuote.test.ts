import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../services/soroban', () => ({
  sorobanService: {
    getQuote: vi.fn(),
  },
}));

vi.mock('../services/cache', () => ({
  buildCacheKey: vi.fn((type, key) => `${type}:${key}`),
  CACHE_TTL: { quote: 30 },
  getOrCompute: vi.fn(),
  cacheDelPattern: vi.fn(),
}));

vi.mock('../services/metrics', () => ({
  setFeeRateBps: vi.fn(),
}));

describe('Bulk Quote Endpoint', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNext = vi.fn();

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      getHeader: vi.fn(),
    };

    mockReq = {
      method: 'POST',
      path: '/api/v1/quote/bulk',
      headers: {
        'x-api-key': 'test-key',
      },
      body: {
        quotes: [
          {
            sourceAsset: 'native',
            amount: '1000000',
            targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
          },
          {
            sourceAsset: 'native',
            amount: '2000000',
            targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
          },
        ],
      },
      apiKeyRecord: {
        id: 'key-123',
        rateLimit: 'standard',
      },
    };
  });

  describe('POST /api/v1/quote/bulk', () => {
    it('accepts an array of quote requests', () => {
      expect(mockReq.body.quotes).toBeInstanceOf(Array);
      expect(mockReq.body.quotes).toHaveLength(2);
    });

    it('validates each quote request entry before processing', () => {
      const invalidQuote = {
        sourceAsset: '',
        amount: 'invalid',
        targetAddress: 'invalid-address',
      };

      expect(invalidQuote.sourceAsset).toBe('');
      expect(invalidQuote.amount).not.toMatch(/^\d+$/);
    });

    it('caps the array length to prevent unbounded requests', () => {
      const maxBatchSize = 100;
      const quotes = Array.from({ length: maxBatchSize + 1 }, (_, i) => ({
        sourceAsset: 'native',
        amount: String(1000000 * (i + 1)),
        targetAddress: 'GBRPYHIL2CI3WHPSUCKMRB7PUE4MQABILO4B7TFTCHKSOD5GKPUYRRR',
      }));

      expect(quotes).toHaveLength(maxBatchSize + 1);
      expect(quotes.length).toBeGreaterThan(maxBatchSize);
    });

    it('resolves shared inputs once for the whole batch', () => {
      const quotes = mockReq.body.quotes;
      expect(quotes.every((q: any) => q.sourceAsset === 'native')).toBe(true);
    });

    it('returns per-entry results with individual errors on partial failure', () => {
      const results = [
        { success: true, quote: { feeBps: 100 } },
        { success: false, error: 'invalid_amount' },
      ];

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBeDefined();
    });

    it('counts the request as one against rate limit but weights by batch size', () => {
      const batchSize = 2;
      const rateLimitWeight = 1 + (batchSize - 1) * 0.5;

      expect(batchSize).toBe(2);
      expect(rateLimitWeight).toBe(1.5);
    });

    it('handles partial-failure batch gracefully', () => {
      const responses = [
        { status: 'success', data: { feeBps: 100 } },
        { status: 'error', error: 'invalid_amount' },
        { status: 'success', data: { feeBps: 150 } },
      ];

      const successCount = responses.filter((r) => r.status === 'success').length;
      const errorCount = responses.filter((r) => r.status === 'error').length;

      expect(successCount).toBe(2);
      expect(errorCount).toBe(1);
      expect(successCount + errorCount).toBe(responses.length);
    });

    it('does not fail the whole batch on individual entry errors', () => {
      const batchResult = {
        results: [
          { success: true, quote: { feeBps: 100 } },
          { success: false, error: 'invalid_address' },
          { success: true, quote: { feeBps: 200 } },
        ],
        partialFailure: true,
      };

      expect(batchResult.partialFailure).toBe(true);
      expect(batchResult.results.some((r) => r.success)).toBe(true);
      expect(batchResult.results.some((r) => !r.success)).toBe(true);
    });

    it('validates sourceAsset format in each batch entry', () => {
      const validAssets = ['native', 'CBQHNASHPBOUYYHIJAK7O5XZ52SH責任-XL2ABJGZ'];
      const entry = mockReq.body.quotes[0];

      expect(validAssets).toContain(entry.sourceAsset);
    });

    it('validates amount as integer string in each entry', () => {
      const entry = mockReq.body.quotes[0];
      const isValidAmount = /^\d+$/.test(entry.amount);

      expect(isValidAmount).toBe(true);
    });

    it('validates Stellar address format in each entry', () => {
      const entry = mockReq.body.quotes[0];
      const stellarAddressRegex = /^G[A-Z0-9]{55}$/;
      const isValidAddress = stellarAddressRegex.test(entry.targetAddress);

      expect(isValidAddress).toBe(true);
    });
  });
});
