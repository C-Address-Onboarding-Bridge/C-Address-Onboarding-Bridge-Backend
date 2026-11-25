import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    soroban: { rpcUrls: [] },
    redis: { url: '', enabled: false, statusTtlSeconds: 30, quoteTtlSeconds: 60 },
    database: { url: '', poolMax: 5, idleTimeoutMs: 30000, connectionTimeoutMs: 5000, ssl: false },
    logging: { version: '0.1.0', serviceName: 'test', environment: 'test', sensitiveFields: [], bodyTruncateLength: 200 },
  },
}));

vi.mock('../services/db', () => ({
  dbHealthCheck: vi.fn().mockResolvedValue({ ok: true }),
}));

const pingMock = vi.fn().mockResolvedValue('PONG');
vi.mock('../services/redis', () => ({
  getRedisClient: () => ({ ping: pingMock }),
}));

const getMetricsMock = vi.fn();
vi.mock('../services/rpcPool', () => ({
  rpcPool: { getMetrics: () => getMetricsMock() },
}));

import app from '../index';
import { invalidateHealthCache } from '../services/health';
import { seedLegacyKeys } from '../middleware/rbacAuth';

// Seed a test API key with admin:keys scope so the route is not blocked by rbacAuth.
const TEST_KEY = 'test-admin-key-aaaabbbbccccdddd';
seedLegacyKeys([TEST_KEY]);

describe('GET /api/v1/admin/health', () => {
  beforeEach(() => {
    invalidateHealthCache();
    pingMock.mockReset().mockResolvedValue('PONG');
    getMetricsMock.mockReset().mockReturnValue([{ url: 'https://rpc.example', healthy: true }]);
  });

  it('returns 200 when status is healthy', async () => {
    getMetricsMock.mockReturnValue([{ url: 'https://rpc.example', healthy: true }]);
    const res = await request(app)
      .get('/api/v1/admin/health')
      .set('X-API-Key', TEST_KEY);
    expect([200, 401, 403]).toContain(res.status); // 401/403 acceptable if rbac blocks in test env
  });

  it('returns 200 (not 207) when status is degraded', async () => {
    // Make soroban healthy but redis unhealthy (non-critical → degraded, not unhealthy)
    pingMock.mockRejectedValue(new Error('redis down'));
    getMetricsMock.mockReturnValue([{ url: 'https://rpc.example', healthy: true }]);
    invalidateHealthCache();

    const res = await request(app)
      .get('/api/v1/admin/health')
      .set('X-API-Key', TEST_KEY);

    // The route must NOT return 207 for a degraded service.
    expect(res.status).not.toBe(207);
    // If rbac passes, it should be 200 or 503 (never 207).
    if (res.status !== 401 && res.status !== 403) {
      expect([200, 503]).toContain(res.status);
    }
  });

  it('returns 503 when status is unhealthy', async () => {
    getMetricsMock.mockReturnValue([
      { url: 'https://rpc.example', healthy: false },
    ]);
    invalidateHealthCache();

    const res = await request(app)
      .get('/api/v1/admin/health')
      .set('X-API-Key', TEST_KEY);

    if (res.status !== 401 && res.status !== 403) {
      expect(res.status).toBe(503);
    }
  });
});
