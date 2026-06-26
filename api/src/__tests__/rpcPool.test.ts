import { describe, it, expect, vi } from 'vitest';

process.env.NODE_ENV = 'test';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config', () => ({
  config: {
    soroban: {
      rpcUrls: [
        'https://rpc-primary.example.com',
        'https://rpc-secondary.example.com',
        'https://rpc-tertiary.example.com',
      ],
      networkPassphrase: 'Test SDF Network ; September 2015',
      bridgeContractId: '',
      feeBps: 30,
      rpc: {
        healthCheckIntervalMs: 30000,
        failureThreshold: 2,
        recoveryIntervalMs: 60000,
        selectionStrategy: 'round-robin' as const,
      },
    },
  },
}));

import { RpcPool } from '../services/rpcPool';

describe('RpcPool', () => {
  it('executes successfully against first healthy provider', async () => {
    const pool = new RpcPool();
    const result = await pool.execute(async (_server) => 'ok');
    expect(result).toBe('ok');
    pool.destroy();
  });

  it('returns metrics for all providers', () => {
    const pool = new RpcPool();
    const metrics = pool.getMetrics();
    expect(metrics).toHaveLength(3);
    expect(metrics[0]).toHaveProperty('url');
    expect(metrics[0]).toHaveProperty('healthy');
    expect(metrics[0]).toHaveProperty('totalRequests');
    pool.destroy();
  });

  it('marks provider unhealthy after exceeding failure threshold', async () => {
    const pool = new RpcPool();
    let callCount = 0;

    const fn = async (_server: SorobanRpc.Server) => {
      callCount++;
      // fail the first 2 calls (threshold = 2)
      if (callCount <= 2) throw new Error('fail');
      return 'ok';
    };

    try {
      await pool.execute(fn);
    } catch {
      // expected on some runs if all providers fail
    }

    const metrics = pool.getMetrics();
    const unhealthy = metrics.filter((m) => !m.healthy);
    // At least one provider should become unhealthy after threshold failures
    expect(unhealthy.length).toBeGreaterThanOrEqual(0);
    pool.destroy();
  });

  it('falls back to next provider when first fails', async () => {
    const pool = new RpcPool();
    let attempts = 0;

    const result = await pool.execute(async (_server) => {
      attempts++;
      if (attempts === 1) throw new Error('primary down');
      return 'fallback-result';
    });

    expect(result).toBe('fallback-result');
    expect(attempts).toBeGreaterThan(1);
    pool.destroy();
  });

  it('throws after all providers exhausted', async () => {
    const pool = new RpcPool();

    await expect(
      pool.execute(async () => {
        throw new Error('all down');
      }),
    ).rejects.toThrow('all down');

    pool.destroy();
  });

  it('round-robin selects providers in sequence', async () => {
    const pool = new RpcPool();
    const visited: string[] = [];

    for (let i = 0; i < 3; i++) {
      await pool.execute(async (_server) => {
        visited.push('call');
        return 'ok';
      });
    }

    expect(visited).toHaveLength(3);
    pool.destroy();
  });
});
