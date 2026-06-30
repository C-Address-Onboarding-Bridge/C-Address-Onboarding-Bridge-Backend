import { describe, it, expect, vi } from 'vitest';

process.env.NODE_ENV = 'test';

vi.mock('../index', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config', () => ({
  config: {
    httpAgent: { maxSockets: 25, maxFreeSockets: 5, keepAliveMsecs: 1000 },
  },
}));

import { SorobanRpc } from '@stellar/stellar-sdk';
import { applyKeepAliveAgents, getAgentStats, destroyAgents } from '../services/httpAgent';

describe('httpAgent (Soroban RPC connection pooling)', () => {
  it('installs keep-alive agents on the Stellar SDK axios client', () => {
    applyKeepAliveAgents();
    const client = SorobanRpc.AxiosClient as { defaults: { httpsAgent?: { keepAlive?: boolean; maxSockets?: number } } };
    expect(client.defaults.httpsAgent?.keepAlive).toBe(true);
    expect(client.defaults.httpsAgent?.maxSockets).toBe(25);
  });

  it('is idempotent', () => {
    expect(() => {
      applyKeepAliveAgents();
      applyKeepAliveAgents();
    }).not.toThrow();
  });

  it('reports socket reuse stats', () => {
    const stats = getAgentStats();
    expect(stats).toHaveProperty('activeSockets');
    expect(stats).toHaveProperty('freeSockets');
    expect(stats).toHaveProperty('pendingRequests');
    expect(stats.activeSockets).toBeGreaterThanOrEqual(0);
  });

  it('destroyAgents drains without throwing', () => {
    expect(() => destroyAgents()).not.toThrow();
  });
});
