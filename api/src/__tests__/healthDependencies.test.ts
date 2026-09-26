import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';

const { mockPing, mockGetMetrics } = vi.hoisted(() => ({
  mockPing: vi.fn().mockResolvedValue('PONG'),
  mockGetMetrics: vi.fn(),
}));

vi.mock('../services/cache', () => ({
  getCacheClient: vi.fn(() => ({
    ping: mockPing,
  })),
}));

vi.mock('../services/rpcPool', () => ({
  rpcPool: {
    getMetrics: mockGetMetrics,
  },
}));

vi.mock('../services/db', () => ({
  dbHealthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
}));

vi.mock('../config', () => ({
  config: {
    soroban: { rpcUrls: ['http://localhost:8000'] },
    redis: { url: 'redis://localhost:6379', enabled: true },
    database: { url: '', poolMax: 5 },
    logging: { version: '0.1.0' },
  },
}));

import { getHealthStatus, invalidateHealthCache } from '../services/health';

describe('health check dependency improvements (#702)', () => {
  beforeEach(() => {
    invalidateHealthCache();
    vi.clearAllMocks();
  });

  it('pings the shared Redis client from getCacheClient()', async () => {
    const result = await getHealthStatus(true);
    expect(mockPing).toHaveBeenCalledOnce();
    expect(result.dependencies.redis.ok).toBe(true);
  });

  it('reports healthy when at least one rpcPool provider is healthy', async () => {
    mockGetMetrics.mockReturnValue([
      { url: 'http://rpc-1', healthy: false, lastLatencyMs: 100 },
      { url: 'http://rpc-2', healthy: true, lastLatencyMs: 45 },
    ]);

    const result = await getHealthStatus(true);
    expect(result.dependencies.soroban.ok).toBe(true);
    expect(result.dependencies.soroban.latencyMs).toBe(45);
  });

  it('reports unhealthy when all rpcPool providers are unhealthy', async () => {
    mockGetMetrics.mockReturnValue([
      { url: 'http://rpc-1', healthy: false, lastLatencyMs: 100 },
      { url: 'http://rpc-2', healthy: false, lastLatencyMs: 200 },
    ]);

    const result = await getHealthStatus(true);
    expect(result.dependencies.soroban.ok).toBe(false);
    expect(result.dependencies.soroban.error).toContain('all rpc providers unhealthy');
  });

  it('treats 4xx HTTP status from raw RPC probe as unhealthy', async () => {
    mockGetMetrics.mockReturnValue([]); // Fallback to direct fetch
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    try {
      const result = await getHealthStatus(true);
      expect(result.dependencies.soroban.ok).toBe(false);
      expect(result.dependencies.soroban.error).toContain('401');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
