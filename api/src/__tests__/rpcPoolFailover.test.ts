import { describe, it, expect, vi, afterEach } from 'vitest';

process.env.NODE_ENV = 'test';

const { config, getNetwork } = vi.hoisted(() => ({
  config: {
    soroban: {
      rpcUrls: [] as string[],
      rpc: {
        healthCheckIntervalMs: 1_000,
        failureThreshold: 2,
        recoveryIntervalMs: 5_000,
        selectionStrategy: 'latency' as 'round-robin' | 'latency' | 'random',
      },
    },
  },
  getNetwork: vi.fn(),
}));

vi.mock('../config', () => ({ config }));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../services/httpAgent', () => ({ applyKeepAliveAgents: vi.fn() }));
vi.mock('@stellar/stellar-sdk', () => ({
  SorobanRpc: {
    Server: class {
      constructor(public url: string) {}
      getNetwork = getNetwork;
    },
  },
}));

import { RpcPool } from '../services/rpcPool';

type FakeServer = { url: string };

describe('RpcPool failover (#688)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a fallback request on the provider that served it', async () => {
    config.soroban.rpcUrls = ['https://rpc-a.example.com', 'https://rpc-b.example.com'];
    const pool = new RpcPool();

    // With no latency samples yet the latency strategy selects rpc-a again on
    // the second attempt, so the pool falls back to the untried rpc-b.
    const result = await pool.execute(async (server) => {
      if ((server as unknown as FakeServer).url.includes('rpc-a')) throw new Error('down');
      return 'ok';
    });

    expect(result).toBe('ok');
    const [a, b] = pool.getMetrics();
    expect(a.totalRequests).toBe(1);
    expect(b.totalRequests).toBe(1);
    pool.destroy();
  });

  it('re-checks and recovers an unhealthy provider in a single-provider pool', async () => {
    vi.useFakeTimers();
    config.soroban.rpcUrls = ['https://rpc-only.example.com'];
    const pool = new RpcPool();

    for (let i = 0; i < 2; i++) {
      await expect(pool.execute(async () => { throw new Error('down'); })).rejects.toThrow('down');
    }
    expect(pool.getMetrics()[0].healthy).toBe(false);

    getNetwork.mockResolvedValueOnce({ passphrase: 'Test SDF Network ; September 2015' });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(getNetwork).toHaveBeenCalled();
    expect(pool.getMetrics()[0].healthy).toBe(true);
    pool.destroy();
  });
});
