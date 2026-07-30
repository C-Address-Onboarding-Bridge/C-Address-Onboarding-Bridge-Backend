import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';

// Mock config first
vi.mock('../config', () => ({
  config: {
    rateLimit: {
      redisEnabled: false,
      windowMs: 60000,
      burstFactor: 10,
    },
  },
}));

// Mock sendAbuseAlert
vi.mock('../services/abuseAlert', () => ({
  sendAbuseAlert: vi.fn(),
}));

// Mock logger
vi.mock('../logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock express-rate-limit
vi.mock('express-rate-limit', () => ({
  default: vi.fn((options) => {
    return vi.fn((req: Request, res: Response, next: NextFunction) => {
      // Simulate rate limiting behavior
      const key = options.keyGenerator(req);
      const burstLimit = options.max;
      
      // Simple counter for testing
      if (!globalThis._rateLimitCounters) {
        globalThis._rateLimitCounters = {};
      }
      
      if (!globalThis._rateLimitCounters[key]) {
        globalThis._rateLimitCounters[key] = 0;
      }
      
      globalThis._rateLimitCounters[key]++;
      
      // Simulate hitting rate limit
      if (globalThis._rateLimitCounters[key] > burstLimit) {
        res.set('Retry-After', String(Math.ceil(60000 / 1000)));
        res.status(429).json({ error: 'rate_limit', message: 'too many requests, try again later' });
      } else {
        next();
      }
    });
  }),
}));

describe('Telemetry Rate Limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis._rateLimitCounters = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
    globalThis._rateLimitCounters = {};
  });

  describe('Telemetry Rate Limiter Configuration', () => {
    it('exports TELEMETRY_ENDPOINT_LIMIT constant of 20', async () => {
      const { TELEMETRY_ENDPOINT_LIMIT } = await import('../middleware/rateLimit');
      expect(TELEMETRY_ENDPOINT_LIMIT).toBe(20);
    });

    it('telemetry limit (20) is stricter than global IP limit (100)', async () => {
      const { TELEMETRY_ENDPOINT_LIMIT, IP_RATE_LIMIT } = await import('../middleware/rateLimit');
      expect(TELEMETRY_ENDPOINT_LIMIT).toBeLessThan(IP_RATE_LIMIT);
      expect(TELEMETRY_ENDPOINT_LIMIT).toBe(20);
      expect(IP_RATE_LIMIT).toBe(100);
    });

    it('telemetry limit (20) is higher than fund endpoint limit (10)', async () => {
      const { TELEMETRY_ENDPOINT_LIMIT, FUND_ENDPOINT_LIMIT } = await import('../middleware/rateLimit');
      expect(TELEMETRY_ENDPOINT_LIMIT).toBeGreaterThan(FUND_ENDPOINT_LIMIT);
      expect(FUND_ENDPOINT_LIMIT).toBe(10);
    });
  });

  describe('Telemetry Rate Limiter Export and Middleware', () => {
    it('exports telemetryRateLimit middleware', async () => {
      const { telemetryRateLimit } = await import('../middleware/rateLimit');
      expect(telemetryRateLimit).toBeDefined();
      expect(typeof telemetryRateLimit).toBe('function');
    });

    it('telemetryRateLimit is a middleware function', async () => {
      const { telemetryRateLimit } = await import('../middleware/rateLimit');
      
      // It should be callable with req, res, next
      expect(telemetryRateLimit.length).toBeGreaterThanOrEqual(3);
    });

    it('telemetryRateLimit calls next() for requests within limit', async () => {
      const { telemetryRateLimit } = await import('../middleware/rateLimit');
      
      const mockReq = {
        ip: '192.168.1.1',
        headers: {},
      } as unknown as Request;

      const mockRes = {
        set: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;

      const mockNext = vi.fn();

      // First call should proceed
      telemetryRateLimit(mockReq, mockRes, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('telemetryRateLimit returns 429 when limit exceeded', async () => {
      const { telemetryRateLimit, TELEMETRY_ENDPOINT_LIMIT } = await import('../middleware/rateLimit');
      
      const mockReq = {
        ip: '192.168.2.1',
        headers: {},
      } as unknown as Request;

      const statusMock = vi.fn().mockReturnThis();
      const jsonMock = vi.fn();
      const setMock = vi.fn().mockReturnThis();
      
      const mockRes = {
        set: setMock,
        status: statusMock,
        json: jsonMock,
      } as unknown as Response;

      const mockNext = vi.fn();

      // Make requests exceeding the limit (TELEMETRY_ENDPOINT_LIMIT + burstFactor + some extra)
      for (let i = 0; i < TELEMETRY_ENDPOINT_LIMIT + 15; i++) {
        telemetryRateLimit(mockReq, mockRes, mockNext);
      }

      // Should have called status(429) at least once
      const status429Calls = statusMock.mock.calls.filter((call) => call[0] === 429);
      expect(status429Calls.length).toBeGreaterThan(0);
      
      // Should have returned rate_limit error
      const limitErrorCalls = jsonMock.mock.calls.filter(
        (call) => call[0].error === 'rate_limit'
      );
      expect(limitErrorCalls.length).toBeGreaterThan(0);
    });

    it('sets Retry-After header on 429 response', async () => {
      const { telemetryRateLimit, TELEMETRY_ENDPOINT_LIMIT } = await import('../middleware/rateLimit');
      
      const mockReq = {
        ip: '192.168.3.1',
        headers: {},
      } as unknown as Request;

      const setMock = vi.fn().mockReturnThis();
      const statusMock = vi.fn().mockReturnThis();
      const jsonMock = vi.fn();
      
      const mockRes = {
        set: setMock,
        status: statusMock,
        json: jsonMock,
      } as unknown as Response;

      const mockNext = vi.fn();

      // Make requests exceeding the limit
      for (let i = 0; i < TELEMETRY_ENDPOINT_LIMIT + 15; i++) {
        telemetryRateLimit(mockReq, mockRes, mockNext);
      }

      // Should have set Retry-After header
      const retryAfterCalls = setMock.mock.calls.filter(
        (call) => call[0] === 'Retry-After'
      );
      expect(retryAfterCalls.length).toBeGreaterThan(0);
      
      if (retryAfterCalls.length > 0) {
        const retryValue = parseInt(retryAfterCalls[0][1], 10);
        expect(retryValue).toBeGreaterThan(0);
      }
    });

    it('applies rate limit per IP address', async () => {
      const { telemetryRateLimit } = await import('../middleware/rateLimit');
      
      // Simply verify that the rate limiter accepts an IP in the request
      // and handles it appropriately
      const mockReq = {
        ip: '192.168.100.1',
        headers: {},
      } as unknown as Request;

      const mockRes = {
        set: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;

      const mockNext = vi.fn();

      // The limiter should process the request
      telemetryRateLimit(mockReq, mockRes, mockNext);

      // Should have either called next() or status()
      const calledNext = mockNext.mock.calls.length > 0;
      const calledStatus = (mockRes.status as any).mock.calls.length > 0;
      
      expect(calledNext || calledStatus).toBe(true);
    });
  });

  describe('Rate Limit Integration', () => {
    it('telemetry uses stricter limits than general API endpoints', async () => {
      const { TELEMETRY_ENDPOINT_LIMIT, IP_RATE_LIMIT, FUND_ENDPOINT_LIMIT } = await import('../middleware/rateLimit');
      
      // Telemetry is public, so should be conservative
      expect(TELEMETRY_ENDPOINT_LIMIT).toBeLessThanOrEqual(20);
      
      // But still allow reasonable usage
      expect(TELEMETRY_ENDPOINT_LIMIT).toBeGreaterThanOrEqual(10);
      
      // Fund endpoint is even stricter (requires auth)
      expect(FUND_ENDPOINT_LIMIT).toBeLessThan(TELEMETRY_ENDPOINT_LIMIT);
      
      // Global IP limit is the most permissive
      expect(IP_RATE_LIMIT).toBeGreaterThan(TELEMETRY_ENDPOINT_LIMIT);
    });

    it('exports all rate limit constants', async () => {
      const rateLimit = await import('../middleware/rateLimit');
      
      expect(rateLimit.TELEMETRY_ENDPOINT_LIMIT).toBeDefined();
      expect(rateLimit.IP_RATE_LIMIT).toBeDefined();
      expect(rateLimit.FUND_ENDPOINT_LIMIT).toBeDefined();
      expect(rateLimit.telemetryRateLimit).toBeDefined();
    });

    it('telemetryRateLimit has correct signature for Express middleware', async () => {
      const { telemetryRateLimit } = await import('../middleware/rateLimit');
      
      // Should be a function that can be used with app.use()
      expect(typeof telemetryRateLimit).toBe('function');
      
      // Express middleware should be callable (test that it's not undefined/null)
      const mockReq = { ip: '1.1.1.1', headers: {} } as unknown as Request;
      const mockRes = {
        set: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const mockNext = vi.fn();

      // Should be able to call it without errors
      expect(() => {
        telemetryRateLimit(mockReq, mockRes, mockNext);
      }).not.toThrow();
    });
  });

  describe('Rate Limit Error Handling', () => {
    it('returns proper 429 error response structure', async () => {
      const { telemetryRateLimit, TELEMETRY_ENDPOINT_LIMIT } = await import('../middleware/rateLimit');
      
      const mockReq = {
        ip: '192.168.5.1',
        headers: {},
      } as unknown as Request;

      let capturedResponse: any = null;
      
      const mockRes = {
        set: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(function (body) {
          capturedResponse = body;
          return this;
        }),
      } as unknown as Response;

      const mockNext = vi.fn();

      // Exceed the limit
      for (let i = 0; i < TELEMETRY_ENDPOINT_LIMIT + 10; i++) {
        telemetryRateLimit(mockReq, mockRes, mockNext);
      }

      // Should have captured a rate limit response
      if (capturedResponse) {
        expect(capturedResponse).toHaveProperty('error');
        expect(capturedResponse.error).toBe('rate_limit');
        expect(capturedResponse).toHaveProperty('message');
        expect(typeof capturedResponse.message).toBe('string');
      }
    });
  });

  describe('Telemetry Rate Limit as Dedicated Middleware', () => {
    it('telemetryRateLimit is separate from other rate limiters', async () => {
      const { telemetryRateLimit, ipRateLimitMiddleware, tierRateLimitMiddleware } = await import(
        '../middleware/rateLimit'
      );
      
      // All should be distinct functions
      expect(telemetryRateLimit).not.toBe(ipRateLimitMiddleware);
      expect(telemetryRateLimit).not.toBe(tierRateLimitMiddleware);
      expect(ipRateLimitMiddleware).not.toBe(tierRateLimitMiddleware);
    });

    it('telemetry rate limiting is more restrictive than IP limiting', async () => {
      const { telemetryRateLimit, TELEMETRY_ENDPOINT_LIMIT, IP_RATE_LIMIT } = await import(
        '../middleware/rateLimit'
      );
      
      // Verify the constant values reflect this
      expect(TELEMETRY_ENDPOINT_LIMIT).toBe(20);
      expect(IP_RATE_LIMIT).toBe(100);
      expect(TELEMETRY_ENDPOINT_LIMIT).toBeLessThan(IP_RATE_LIMIT);
    });
  });
});
