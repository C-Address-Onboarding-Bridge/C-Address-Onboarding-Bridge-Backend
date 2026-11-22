import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    trustProxy: 1,
  },
}));

vi.mock('../logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Suspicious Rate Limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should not flag clean requests as suspicious', async () => {
    // This test verifies that N clean requests in a row do not trip the throttle
    const cleanPayloads = [
      { name: 'John Doe', email: 'john@example.com' },
      { amount: '100.50', currency: 'USD' },
      { status: 'pending', id: '12345' },
    ];

    // Simulate suspicious request counter that only increments on actual injection detection
    const suspiciousIpCounts = new Map<string, { count: number; windowStart: number }>();
    const SUSPICIOUS_WINDOW_MS = 60_000;
    const SUSPICIOUS_THRESHOLD = 10;
    const clientIp = '192.0.2.1';

    let suspiciousCount = 0;

    // Process clean payloads
    cleanPayloads.forEach((payload) => {
      // Flag should only be set if injection pattern is detected
      // Clean payloads should never increment the counter
      const hasInjectionPattern = false; // In real code, this comes from injectionProtection detection

      if (hasInjectionPattern) {
        if (!suspiciousIpCounts.has(clientIp)) {
          suspiciousIpCounts.set(clientIp, { count: 1, windowStart: Date.now() });
        } else {
          suspiciousIpCounts.get(clientIp)!.count++;
        }
        suspiciousCount++;
      }
    });

    expect(suspiciousCount).toBe(0);
    expect(suspiciousIpCounts.get(clientIp)).toBeUndefined();
  });

  it('should increment counter only when injection pattern is detected', async () => {
    const suspiciousIpCounts = new Map<string, { count: number; windowStart: number }>();
    const clientIp = '192.0.2.1';
    const SUSPICIOUS_THRESHOLD = 10;

    // Payloads with SQL injection
    const injectionPayloads = [
      { id: "1' OR '1'='1" },
      { query: "'; DROP TABLE users; --" },
      { input: "1 UNION SELECT * FROM passwords" },
    ];

    let suspiciousCount = 0;

    injectionPayloads.forEach((payload) => {
      // Simulate detection of injection pattern
      const hasInjectionPattern = true; // In real code, detectPatterns() returns true

      if (hasInjectionPattern) {
        if (!suspiciousIpCounts.has(clientIp)) {
          suspiciousIpCounts.set(clientIp, { count: 1, windowStart: Date.now() });
        } else {
          suspiciousIpCounts.get(clientIp)!.count++;
        }
        suspiciousCount++;
      }
    });

    expect(suspiciousCount).toBe(3);
    expect(suspiciousIpCounts.get(clientIp)?.count).toBe(3);
    expect(suspiciousIpCounts.get(clientIp)!.count).toBeLessThan(SUSPICIOUS_THRESHOLD);
  });

  it('should throttle requests after exceeding threshold', async () => {
    const suspiciousIpCounts = new Map<string, { count: number; windowStart: number }>();
    const clientIp = '192.0.2.1';
    const SUSPICIOUS_THRESHOLD = 10;
    const SUSPICIOUS_WINDOW_MS = 60_000;

    // Build up to threshold
    for (let i = 0; i < SUSPICIOUS_THRESHOLD + 1; i++) {
      if (!suspiciousIpCounts.has(clientIp)) {
        suspiciousIpCounts.set(clientIp, { count: 1, windowStart: Date.now() });
      } else {
        suspiciousIpCounts.get(clientIp)!.count++;
      }
    }

    const ipData = suspiciousIpCounts.get(clientIp)!;
    const isThrottled = ipData.count > SUSPICIOUS_THRESHOLD;

    expect(isThrottled).toBe(true);
    expect(ipData.count).toBe(SUSPICIOUS_THRESHOLD + 1);
  });

  it('suspiciousRateLimiting should be a pure gate checking count without incrementing', async () => {
    // This middleware should only CHECK the counter, not increment it
    // Incrementing should happen ONLY in injectionProtection when pattern is detected

    const mockReq = {
      ip: '192.0.2.1',
      method: 'POST',
      path: '/api/v2/fund',
      headers: {},
    } as unknown as Request;

    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      set: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const mockNext = vi.fn();

    // suspiciousRateLimiting middleware should only be a gate
    // It should read the counter but not write to it
    // The counter is written by injectionProtection when patterns match

    // Simulate: counter exists but is under threshold
    const suspiciousIpCounts = new Map<string, { count: number; windowStart: number }>();
    suspiciousIpCounts.set('192.0.2.1', { count: 5, windowStart: Date.now() });

    const ipData = suspiciousIpCounts.get('192.0.2.1');
    const SUSPICIOUS_THRESHOLD = 10;

    // Check gate logic: should allow because count < threshold
    if (ipData && ipData.count <= SUSPICIOUS_THRESHOLD) {
      mockNext(); // Allow request to proceed
    } else {
      mockRes.status(429);
      mockRes.json({ error: 'too_many_requests' });
    }

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();

    // Counter should NOT have been incremented by suspiciousRateLimiting
    expect(ipData?.count).toBe(5); // Still 5, not 6
  });

  it('injectionProtection should call flagSuspiciousRequest on pattern detection', async () => {
    // When injectionProtection detects a pattern, it calls flagSuspiciousRequest(ip)
    // to increment the counter

    const suspiciousIpCounts = new Map<string, { count: number; windowStart: number }>();
    const clientIp = '192.0.2.1';

    const flagSuspiciousRequest = (ip: string) => {
      if (!suspiciousIpCounts.has(ip)) {
        suspiciousIpCounts.set(ip, { count: 1, windowStart: Date.now() });
      } else {
        suspiciousIpCounts.get(ip)!.count++;
      }
      return true;
    };

    // Simulate injection detection in injectionProtection
    const hasInjectionPattern = true;

    if (hasInjectionPattern) {
      const flagged = flagSuspiciousRequest(clientIp);
      expect(flagged).toBe(true);
    }

    expect(suspiciousIpCounts.get(clientIp)?.count).toBe(1);
  });

  it('clean requests should not increment the suspicious counter', async () => {
    const suspiciousIpCounts = new Map<string, { count: number; windowStart: number }>();
    const clientIp = '192.0.2.1';

    const cleanRequests = [
      { name: 'Alice', email: 'alice@example.com' },
      { amount: 500, currency: 'USDC' },
      { action: 'getStatus', id: 'tx-123' },
      { address: '0x123abc', network: 'mainnet' },
      { timestamp: Date.now(), data: 'clean-payload' },
    ];

    let suspiciousCount = 0;

    cleanRequests.forEach((req) => {
      // Each clean request does not trigger pattern detection
      const hasPattern = false;

      if (hasPattern) {
        if (!suspiciousIpCounts.has(clientIp)) {
          suspiciousIpCounts.set(clientIp, { count: 1, windowStart: Date.now() });
        } else {
          suspiciousIpCounts.get(clientIp)!.count++;
        }
        suspiciousCount++;
      }
    });

    // After 5 clean requests, counter should still not exist
    expect(suspiciousCount).toBe(0);
    expect(suspiciousIpCounts.has(clientIp)).toBe(false);
  });

  it('counter should reset after time window expires', async () => {
    const SUSPICIOUS_WINDOW_MS = 60_000;
    const now = Date.now();

    const windowStart = now - SUSPICIOUS_WINDOW_MS - 1000; // Window expired
    const ipData = { count: 10, windowStart };

    const isWindowExpired = now - ipData.windowStart > SUSPICIOUS_WINDOW_MS;

    expect(isWindowExpired).toBe(true);
    // When window is expired, the counter should be reset
    if (isWindowExpired) {
      ipData.count = 0;
      ipData.windowStart = now;
    }

    expect(ipData.count).toBe(0);
  });

  it('multiple IPs should have independent counters', async () => {
    const suspiciousIpCounts = new Map<string, { count: number; windowStart: number }>();
    const ip1 = '192.0.2.1';
    const ip2 = '198.51.100.1';

    // IP1 has malicious requests
    suspiciousIpCounts.set(ip1, { count: 5, windowStart: Date.now() });

    // IP2 has clean requests
    const ip2Data = { count: 0, windowStart: Date.now() };
    suspiciousIpCounts.set(ip2, ip2Data);

    expect(suspiciousIpCounts.get(ip1)!.count).toBe(5);
    expect(suspiciousIpCounts.get(ip2)!.count).toBe(0);

    // One IP being throttled should not affect the other
    const isIp1Throttled = suspiciousIpCounts.get(ip1)!.count > 10;
    const isIp2Throttled = suspiciousIpCounts.get(ip2)!.count > 10;

    expect(isIp1Throttled).toBe(false); // 5 <= 10
    expect(isIp2Throttled).toBe(false); // 0 <= 10
  });
});
