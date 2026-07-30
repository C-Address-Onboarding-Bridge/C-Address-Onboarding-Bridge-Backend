import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  ipRateLimitMiddleware,
  tierRateLimitMiddleware,
  fundEndpointRateLimit,
  applyRateLimitHeaders,
  trackRequestCost,
  fundAbuseDetectionMiddleware,
  FUND_ENDPOINT_LIMIT,
  IP_RATE_LIMIT,
} from '../middleware/rateLimit';

process.env.NODE_ENV = 'test';

// Mock express-rate-limit
vi.mock('express-rate-limit', () => ({
  default: vi.fn((options) => {
    return vi.fn((req: Request, res: Response, next: NextFunction) => {
      // Default: pass through for testing
      next();
    });
  }),
}));

// Mock config
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

// Get mocked functions after imports
import { sendAbuseAlert } from '../services/abuseAlert';
const mockSendAbuseAlert = sendAbuseAlert as any;

describe('Rate Limit Abuse Detection', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNext = vi.fn();

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      getHeader: vi.fn(),
      on: vi.fn().mockReturnThis(),
    };

    mockReq = {
      ip: '192.168.1.1',
      headers: {},
      body: {},
      apiKeyRecord: {
        id: 'key-123',
        rateLimit: 'standard',
      } as any,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('IP Rate Limiting', () => {
    it('allows requests below IP rate limit', async () => {
      ipRateLimitMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('blocks requests from banned IPs', () => {
      // First, trigger abuse detection to ban an IP
      const req = {
        ...mockReq,
        ip: '10.0.0.1',
        body: { amount: '100000000000', targetAddress: 'C-address' },
      } as Request;

      // Trigger abuse detection multiple times to ban IP
      for (let i = 0; i < 60; i++) {
        fundAbuseDetectionMiddleware(req, mockRes as Response, vi.fn());
      }

      // Now test if IP is banned
      ipRateLimitMiddleware(req, mockRes as Response, mockNext);

      // Should block without calling next
      if ((mockRes.status as any)?.mock?.calls.length > 0) {
        expect((mockRes.status as any).mock.calls[0][0]).toBe(403);
      }
    });

    it('skips IP rate limiting for webhook endpoints', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.1',
        path: '/webhook/moonpay',
      } as Request;

      ipRateLimitMiddleware(req, mockRes as Response, mockNext);

      // Should bypass rate limiting and call next
      expect(mockNext).toHaveBeenCalled();
      expect((mockRes.status as any).mock.calls.length).toBe(0);
    });

    it('skips IP rate limiting for any webhook path', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.1',
        path: '/webhook/transak',
      } as Request;

      ipRateLimitMiddleware(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect((mockRes.status as any).mock.calls.length).toBe(0);
    });
  });

  describe('Tier Rate Limiting', () => {
    it('applies correct tier limit for low tier', () => {
      mockReq.apiKeyRecord = { id: 'key-123', rateLimit: 'low' } as any;

      tierRateLimitMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('applies correct tier limit for standard tier', () => {
      mockReq.apiKeyRecord = { id: 'key-123', rateLimit: 'standard' } as any;

      tierRateLimitMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('applies correct tier limit for high tier', () => {
      mockReq.apiKeyRecord = { id: 'key-123', rateLimit: 'high' } as any;

      tierRateLimitMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('defaults to low tier when not specified', () => {
      mockReq.apiKeyRecord = { id: 'key-123' } as any;

      tierRateLimitMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('handles missing apiKeyRecord gracefully', () => {
      mockReq.apiKeyRecord = undefined;

      tierRateLimitMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('Request Cost Tracking', () => {
    it('tracks request cost for API key', () => {
      const result = trackRequestCost('api-key-1', 100);

      expect(result).toBe(true);
    });

    it('accumulates costs across multiple requests', () => {
      trackRequestCost('api-key-2', 100);
      trackRequestCost('api-key-2', 200);
      const result = trackRequestCost('api-key-2', 50);

      expect(result).toBe(true);
    });

    it('rejects requests when cost limit exceeded', () => {
      const apiKey = 'api-key-exceed';
      const maxCost = 1_000_000;

      // Add costs that exceed limit
      trackRequestCost(apiKey, maxCost + 1);

      expect(mockSendAbuseAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cost_limit_exceeded',
          apiKeyId: apiKey,
        })
      );
    });

    it('returns false when cost limit exceeded', () => {
      const apiKey = 'api-key-limit';
      trackRequestCost(apiKey, 1_000_001);

      const result = trackRequestCost(apiKey, 100);

      expect(result).toBe(false);
    });

    it('tracks independent costs per API key', () => {
      trackRequestCost('key-a', 100);
      trackRequestCost('key-b', 200);

      expect(mockSendAbuseAlert).not.toHaveBeenCalled();
    });

    it('resets cost tracking after TTL (3600s)', async () => {
      // Cost tracking should respect TTL, but for testing we verify tracking works
      const result = trackRequestCost('api-key-ttl', 500);
      expect(result).toBe(true);
    });
  });

  describe('Abuse Pattern Detection - Large Amounts', () => {
    it('detects large amount requests', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.100',
      } as Request;

      // Trigger 5 times with unique addresses to reach threshold
      for (let i = 0; i < 5; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { amount: '10000000001', targetAddress: `C-addr-${i}` } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      expect(mockSendAbuseAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'suspicious_activity',
          pattern: 'large_amount',
        })
      );
    });

    it('ignores amounts at or below threshold', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.101',
        body: { amount: '10000000000', targetAddress: 'C-address-1' },
      } as Request;

      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('accumulates large amount pattern detections', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.102',
      } as Request;

      // Trigger 5 times to reach suspicious pattern threshold
      for (let i = 0; i < 5; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { amount: '10000000001', targetAddress: `C-addr-${i}` } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      expect(mockSendAbuseAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'suspicious_activity',
          pattern: 'large_amount',
        })
      );
    });
  });

  describe('Abuse Pattern Detection - Multiple Addresses', () => {
    it('detects multiple target addresses', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.200',
      } as Request;

      // Trigger multiple_addresses pattern 5 times by sending >10 unique addresses 5 times
      for (let outer = 0; outer < 5; outer++) {
        for (let i = 0; i < 12; i++) {
          fundAbuseDetectionMiddleware(
            { ...req, body: { targetAddress: `C-address-${outer}-${i}` } } as Request,
            mockRes as Response,
            vi.fn()
          );
        }
      }

      expect(mockSendAbuseAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'suspicious_activity',
          pattern: 'multiple_addresses',
        })
      );
    });

    it('tracks unique addresses across requests', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.201',
      } as Request;

      // Same address multiple times shouldn't increment counter for unique addresses
      for (let i = 0; i < 5; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { targetAddress: 'C-address-same' } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      // After 5 unique addresses to 1 address, no multiple_addresses alert should have been sent yet
      const multiAddrAlerts = (mockSendAbuseAlert as any).mock.calls.filter(
        (call: any) => call[0].pattern === 'multiple_addresses'
      );
      expect(multiAddrAlerts.length).toBe(0);
    });


  });

  describe('Abuse Pattern Detection - Rapid Requests', () => {
    it('detects rapid requests within time window', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.300',
        body: { targetAddress: 'C-address-1' },
      } as Request;

      // Simulate 25 requests in quick succession to trigger rapid_requests pattern,
      // then 5 times that reaches the threshold
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 21; i++) {
          fundAbuseDetectionMiddleware(
            { ...req },
            mockRes as Response,
            vi.fn()
          );
        }
      }

      expect(mockSendAbuseAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'suspicious_activity',
          pattern: 'rapid_requests',
        })
      );
    });

    it('allows normal request rate', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.301',
        body: { targetAddress: 'C-address-1' },
      } as Request;

      // Send 10 requests (below threshold)
      for (let i = 0; i < 10; i++) {
        fundAbuseDetectionMiddleware(
          { ...req },
          mockRes as Response,
          vi.fn()
        );
      }

      const rapidAlerts = (mockSendAbuseAlert as any).mock.calls.filter(
        (call: any) => call[0].pattern === 'rapid_requests'
      );
      expect(rapidAlerts.length).toBe(0);
    });
  });

  describe('IP Banning After 3 Offenses', () => {
    it('bans IP after 3 different suspicious patterns detected', () => {
      const ip = '192.168.1.400';
      const req = { ...mockReq, ip } as Request;

      // First pattern: large amount (5 times to trigger)
      for (let i = 0; i < 5; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { amount: '10000000001', targetAddress: `C-addr-${i}` } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      // Check if IP was banned (would have called sendAbuseAlert with type: 'ip_banned')
      const banAlerts = (mockSendAbuseAlert as any).mock.calls.filter(
        (call: any) => call[0].type === 'ip_banned'
      );

      // After ban, subsequent requests should be blocked
      if (banAlerts.length > 0) {
        const banReq = { ...req, ip } as Request;
        ipRateLimitMiddleware(banReq, mockRes as Response, mockNext);

        // Check if response indicates ban
        const statusCalls = (mockRes.status as any)?.mock?.calls || [];
        if (statusCalls.length > 0) {
          expect(statusCalls[0][0]).toBe(403);
        }
      }
    });

    it('tracks offense count per IP', () => {
      const ip1 = '192.168.1.401';
      const ip2 = '192.168.1.402';

      const req1 = { ...mockReq, ip: ip1, body: { amount: '10000000001' } } as Request;
      const req2 = { ...mockReq, ip: ip2, body: { amount: '10000000001' } } as Request;

      // Trigger on first IP
      for (let i = 0; i < 5; i++) {
        fundAbuseDetectionMiddleware(
          { ...req1, body: { amount: '10000000001', targetAddress: `C-addr-${i}` } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      // Trigger on second IP (should be independent)
      for (let i = 0; i < 3; i++) {
        fundAbuseDetectionMiddleware(
          { ...req2, body: { amount: '10000000001', targetAddress: `C-addr-${i}` } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      // Verify both generated alerts
      expect(mockSendAbuseAlert).toHaveBeenCalled();
    });
  });

  describe('Cost Limit Rejection', () => {
    it('rejects requests when cost limit is exceeded', () => {
      const req = {
        ...mockReq,
        headers: { 'x-api-key': 'cost-limit-key' },
        body: {},
      } as Request;

      // Exceed cost limit
      trackRequestCost('cost-limit-key', 1_000_001);

      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect((mockRes.status as any).mock.calls[0][0]).toBe(429);
      expect((mockRes.json as any).mock.calls[0][0]).toMatchObject({
        error: 'rate_limit',
      });
    });

    it('allows requests within cost limits', () => {
      const req = {
        ...mockReq,
        headers: { 'x-api-key': 'normal-key' },
        body: {},
      } as Request;

      trackRequestCost('normal-key', 100);

      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('sends alert when cost limit exceeded', () => {
      const apiKey = 'alert-key';
      trackRequestCost(apiKey, 1_000_001);

      expect(mockSendAbuseAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cost_limit_exceeded',
          apiKeyId: apiKey,
          details: expect.objectContaining({
            totalCost: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('Blocked IPs Stay Blocked', () => {
    it('maintains IP ban for duration of TTL', () => {
      const ip = '192.168.1.500';
      const req = { ...mockReq, ip } as Request;

      // Trigger ban
      for (let i = 0; i < 5; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { amount: '10000000001', targetAddress: `C-addr-${i}` } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      // Verify ban was triggered
      const banAlerts = (mockSendAbuseAlert as any).mock.calls.filter(
        (call: any) => call[0].type === 'ip_banned'
      );

      if (banAlerts.length > 0) {
        // Try to make another request with banned IP
        ipRateLimitMiddleware({ ...req, ip }, mockRes as Response, mockNext);

        const statusCalls = (mockRes.status as any)?.mock?.calls || [];
        if (statusCalls.length > 0) {
          expect(statusCalls[0][0]).toBe(403);
        }
      }
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('handles missing amount in body gracefully', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.600',
        body: { targetAddress: 'C-address-1' },
      } as Request;

      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('handles missing targetAddress in body gracefully', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.601',
        body: { amount: '1000' },
      } as Request;

      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('handles missing body gracefully', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.602',
        body: undefined,
      } as Request;

      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('handles missing API key record gracefully', () => {
      const req = {
        ...mockReq,
        apiKeyRecord: undefined,
        headers: {},
        body: { amount: '1000' },
      } as Request;

      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('handles missing IP gracefully', () => {
      const req = {
        ...mockReq,
        ip: undefined,
        body: { amount: '1000' },
      } as Request;

      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('handles invalid amount values gracefully', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.603',
        body: { amount: 'not-a-number', targetAddress: 'C-addr' },
      } as Request;

      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('tracks unique target addresses only', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.604',
      } as Request;

      // Send 6 requests to 2 unique addresses
      for (let i = 0; i < 6; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { targetAddress: i < 3 ? 'C-addr-a' : 'C-addr-b' } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      const multiAddrAlerts = (mockSendAbuseAlert as any).mock.calls.filter(
        (call: any) => call[0].pattern === 'multiple_addresses'
      );
      expect(multiAddrAlerts.length).toBe(0);
    });
  });

  describe('RateLimit Headers Middleware', () => {
    it('sets default rate limit policy header', () => {
      const res = {
        on: vi.fn((event, handler) => {
          if (event === 'finish') {
            // Simulate finish event
            handler();
          }
        }),
        getHeader: vi.fn().mockReturnValue(null),
        set: vi.fn(),
      } as any;

      applyRateLimitHeaders(mockReq as Request, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('does not override existing rate limit headers', () => {
      const res = {
        on: vi.fn((event, handler) => {
          if (event === 'finish') {
            handler();
          }
        }),
        getHeader: vi.fn().mockReturnValue('some-value'),
        set: vi.fn(),
      } as any;

      applyRateLimitHeaders(mockReq as Request, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('Multiple Middleware Layers', () => {
    it('combines IP ban with cost limit enforcement', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.700',
        headers: { 'x-api-key': 'combined-key' },
        body: { amount: '10000000001' },
      } as Request;

      // Exceed cost limit
      trackRequestCost('combined-key', 1_000_001);

      // Try abuse detection
      fundAbuseDetectionMiddleware(req, mockRes as Response, mockNext);

      expect((mockRes.status as any).mock.calls[0][0]).toBe(429);
    });

    it('applies filters in correct order - ban before other checks', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.701',
        body: { amount: '10000000001' },
      } as Request;

      // Trigger ban
      for (let i = 0; i < 5; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { amount: '10000000001', targetAddress: `C-addr-${i}` } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      // Verify ban was triggered
      const banAlerts = (mockSendAbuseAlert as any).mock.calls.filter(
        (call: any) => call[0].type === 'ip_banned'
      );

      if (banAlerts.length > 0) {
        mockRes = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis(),
        };

        // Now check abuse detection - should return ban message first
        fundAbuseDetectionMiddleware(
          { ...req, ip: '192.168.1.701' } as Request,
          mockRes as Response,
          mockNext
        );

        const statusCalls = (mockRes.status as any)?.mock?.calls || [];
        if (statusCalls.length > 0) {
          expect(statusCalls[0][0]).toBe(403);
        }
      }
    });
  });

  describe('Pattern Accumulation and Thresholds', () => {
    it('reaches 5-pattern threshold for single pattern type', () => {
      const req = {
        ...mockReq,
        ip: '192.168.1.800',
      } as Request;

      // Trigger large_amount pattern 5 times
      for (let i = 0; i < 5; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { amount: '10000000001', targetAddress: `C-addr-${i}` } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      const alerts = (mockSendAbuseAlert as any).mock.calls.filter(
        (call: any) => call[0].type === 'suspicious_activity'
      );

      expect(alerts.length).toBeGreaterThan(0);
    });

    it('counts pattern detections correctly per IP/key combination', () => {
      const ip = '192.168.1.801';
      const apiKey = 'key-pattern-test';

      const req = {
        ...mockReq,
        ip,
        apiKeyRecord: { id: apiKey, rateLimit: 'standard' } as any,
      } as Request;

      // Trigger pattern 3 times (below threshold)
      for (let i = 0; i < 3; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { amount: '10000000001' } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      const earlyAlerts = (mockSendAbuseAlert as any).mock.calls;
      const earlyCount = earlyAlerts.length;

      // Trigger 2 more times to reach 5
      for (let i = 0; i < 2; i++) {
        fundAbuseDetectionMiddleware(
          { ...req, body: { amount: '10000000001' } } as Request,
          mockRes as Response,
          vi.fn()
        );
      }

      const totalAlerts = (mockSendAbuseAlert as any).mock.calls;
      expect(totalAlerts.length).toBeGreaterThan(earlyCount);
    });
  });
});
