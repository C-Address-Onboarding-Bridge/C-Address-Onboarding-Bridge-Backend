import { describe, it, expect, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: { rateLimit: { redisEnabled: false, windowMs: 60000, burstFactor: 10 } },
}));
vi.mock('../logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { register, recordSorobanRpcCall } from '../services/metrics';
import { IP_RATE_LIMIT, ipRateLimitMiddleware } from '../middleware/rateLimit';

function makeRes(): Response {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe('monitoring metrics are recorded', () => {
  it('recordSorobanRpcCall increments call, error and duration series', async () => {
    recordSorobanRpcCall('getTransaction', 0.02, true);
    recordSorobanRpcCall('getTransaction', 0.5, false);
    const output = await register.metrics();
    expect(output).toContain('soroban_rpc_calls_total{method="getTransaction",status="success"} 1');
    expect(output).toContain('soroban_rpc_errors_total{method="getTransaction"} 1');
    expect(output).toContain('soroban_rpc_duration_seconds_count{method="getTransaction"} 2');
  });

  it('a rate-limited request increments http_rate_limit_hits_total', async () => {
    const req = { ip: '203.0.113.7', socket: {} } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    for (let i = 0; i <= IP_RATE_LIMIT.max; i++) {
      ipRateLimitMiddleware(req, makeRes(), next);
    }
    const output = await register.metrics();
    expect(output).toContain('http_rate_limit_hits_total{route="ip"} 1');
  });
});
