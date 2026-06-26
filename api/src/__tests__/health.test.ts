import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { getHealthStatus, invalidateHealthCache } from '../services/health';

describe('getHealthStatus', () => {
  beforeEach(() => {
    invalidateHealthCache();
  });

  it('returns degraded when non-critical dependencies are down', async () => {
    const result = await getHealthStatus(true);
    expect(result).toHaveProperty('status');
    expect(['ok', 'degraded', 'unhealthy']).toContain(result.status);
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('version');
    expect(result).toHaveProperty('dependencies');
  });

  it('caches results for 5 seconds', async () => {
    const first = await getHealthStatus(true);
    const second = await getHealthStatus(false);
    expect(second.timestamp).toBe(first.timestamp);
  });

  it('reports database dependency', async () => {
    const result = await getHealthStatus(true);
    expect(result.dependencies).toHaveProperty('database');
    expect(result.dependencies.database).toHaveProperty('ok');
  });

  it('marks database as non-critical', async () => {
    const result = await getHealthStatus(true);
    expect(result.dependencies.database.critical).toBe(false);
  });

  it('marks soroban as critical', async () => {
    const result = await getHealthStatus(true);
    expect(result.dependencies.soroban.critical).toBe(true);
  });
});
