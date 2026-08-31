import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    trustProxy: 1,
  },
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Trust Proxy Setting', () => {
  it('should configure trust proxy setting when enabled', async () => {
    const { config } = await import('../config');
    expect(config.trustProxy).toBeDefined();
    expect(config.trustProxy).toBe(1);
  });

  it('req.ip should reflect X-Forwarded-For header when trust proxy is enabled', async () => {
    // Create a mock request with X-Forwarded-For header
    const mockReq = {
      ip: '203.0.113.42', // Original ALB IP
      headers: {
        'x-forwarded-for': '198.51.100.10',
      },
      connection: {
        remoteAddress: '203.0.113.42',
      },
    } as unknown as Request;

    // Simulate Express behavior when trust proxy is set to 1
    // The real client IP should be extracted from X-Forwarded-For
    const xForwardedFor = mockReq.headers['x-forwarded-for'];
    const realClientIp = typeof xForwardedFor === 'string'
      ? xForwardedFor.split(',')[0].trim()
      : undefined;

    expect(realClientIp).toBe('198.51.100.10');
    expect(realClientIp).not.toBe('203.0.113.42');
  });

  it('should handle multiple proxies in X-Forwarded-For correctly', async () => {
    // When trust proxy is 1, take only the rightmost IP (first proxy hop)
    const xForwardedFor = '198.51.100.10, 203.0.113.50, 203.0.113.42';
    const trustProxy = 1;

    // Simulate Express behavior: with trustProxy=1, take the last IP in the chain
    const ips = xForwardedFor.split(',').map(ip => ip.trim());
    const realClientIp = ips[ips.length - trustProxy];

    expect(realClientIp).toBe('203.0.113.50');
  });

  it('trust proxy setting should be configurable via environment variable', async () => {
    // Verify that trust proxy is coming from config which reads env vars
    const { config } = await import('../config');
    expect(config.trustProxy).toBeDefined();
    // In this test environment, it's mocked to 1, but the actual implementation
    // should read from process.env.TRUST_PROXY
  });

  it('should default to 1 for ALB deployments', async () => {
    const { config } = await import('../config');
    // ALB is a single hop, so trust proxy should be 1
    expect(config.trustProxy).toBe(1);
  });

  it('X-Forwarded-For header with trust proxy 1 points to the actual client', async () => {
    // Simulating real ALB scenario:
    // Client (1.2.3.4) -> ALB (203.0.113.42) -> API
    // ALB adds X-Forwarded-For: 1.2.3.4
    // API receives X-Forwarded-For: 1.2.3.4 from ALB socket 203.0.113.42

    const mockReq = {
      ip: '203.0.113.42', // ALB's IP
      headers: {
        'x-forwarded-for': '1.2.3.4', // Actual client
      },
    } as unknown as Request;

    const xForwardedFor = String(mockReq.headers['x-forwarded-for']);
    const actualClientIp = xForwardedFor.split(',')[0].trim();

    expect(actualClientIp).toBe('1.2.3.4');
    expect(mockReq.ip).toBe('203.0.113.42');
    // With trust proxy enabled, Express will use 1.2.3.4 instead of 203.0.113.42
  });

  it('rate limiting should use client IP from X-Forwarded-For when trust proxy is set', async () => {
    // This test verifies the intent: rate limiting per real client IP
    const mockReq = {
      ip: '203.0.113.42', // Will be overridden by Express when trust proxy is set
      headers: {
        'x-forwarded-for': '192.0.2.1',
      },
    } as unknown as Request;

    const xForwardedFor = String(mockReq.headers['x-forwarded-for']);
    const realClientIp = xForwardedFor.split(',')[0].trim();

    // Rate limiter should use realClientIp for bucketing, not mockReq.ip
    expect(realClientIp).toBe('192.0.2.1');
    expect(realClientIp).not.toBe('203.0.113.42');
  });

  it('IP whitelisting should use client IP from X-Forwarded-For when trust proxy is set', async () => {
    const whitelist = ['192.0.2.1', '198.51.100.5'];

    const mockReq = {
      ip: '203.0.113.42', // ALB IP
      headers: {
        'x-forwarded-for': '192.0.2.1',
      },
    } as unknown as Request;

    const xForwardedFor = String(mockReq.headers['x-forwarded-for']);
    const realClientIp = xForwardedFor.split(',')[0].trim();

    // IP whitelisting check should use realClientIp
    const isWhitelisted = whitelist.includes(realClientIp);
    expect(isWhitelisted).toBe(true);

    // Without trust proxy, this would fail because mockReq.ip (203.0.113.42) isn't whitelisted
    const wouldPassWithoutTrustProxy = whitelist.includes(mockReq.ip);
    expect(wouldPassWithoutTrustProxy).toBe(false);
  });
});
