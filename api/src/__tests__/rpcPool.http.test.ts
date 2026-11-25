import { afterEach, describe, expect, it, vi } from 'vitest';

const envBefore = process.env.NODE_ENV;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../config');
  if (envBefore === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = envBefore;
});

function mockConfig(url: string) {
  vi.doMock('../config', () => ({
    config: {
      logLevel: 'info',
      logging: { sensitiveFields: [] },
      soroban: {
        rpcUrls: [url],
        rpc: {
          selectionStrategy: 'round-robin',
          failureThreshold: 3,
          recoveryIntervalMs: 60_000,
          healthCheckIntervalMs: 60_000,
        },
      },
    },
    ConfigError: class ConfigError extends Error {
      constructor(message: string) { super(message); this.name = 'ConfigError'; }
    },
  }));
}

describe('RpcPool HTTP endpoint configuration', () => {
  it('constructs a pool for a local HTTP RPC endpoint outside production', async () => {
    process.env.NODE_ENV = 'development';
    mockConfig('http://localhost:8000/soroban/rpc');
    const { RpcPool } = await import('../services/rpcPool');

    const pool = new RpcPool();
    expect(pool.getMetrics()).toHaveLength(1);
    pool.destroy();
  });

  it('reports a configuration error for HTTP endpoints in production', async () => {
    process.env.NODE_ENV = 'production';
    mockConfig('http://localhost:8000/soroban/rpc');
    await expect(import('../services/rpcPool')).rejects.toThrow(
      /SOROBAN_RPC_URL\(S\) must use HTTPS in production/,
    );
  });
});
