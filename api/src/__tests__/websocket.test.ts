import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';

vi.mock('../config', () => ({
  config: {
    apiKeys: ['test-token'],
    websocket: { authRequired: true, maxSubscriptionsPerConnection: 10 },
    soroban: { rpcUrls: ['https://example.com'] },
    redis: { url: '', statusTtlSeconds: 30, quoteTtlSeconds: 60, enabled: false },
    logLevel: 'silent',
    logging: { serviceName: 'test', version: '0.0.0', environment: 'test', sensitiveFields: [], bodyTruncateLength: 200 },
  },
}));

vi.mock('../services/soroban', () => ({
  sorobanService: {
    getTransactionStatus: vi.fn().mockResolvedValue({ status: 'pending', hash: 'a'.repeat(64) }),
  },
}));

vi.mock('../services/explorer', () => ({
  explorerService: {
    txUrl: vi.fn().mockReturnValue('https://explorer.example.com/tx'),
  },
}));

import { createWebSocketServer } from '../services/websocket';
import { WebSocketServer } from 'ws';

describe('createWebSocketServer', () => {
  it('returns a WebSocketServer instance', () => {
    const wss = createWebSocketServer();
    expect(wss).toBeInstanceOf(WebSocketServer);
    wss.close();
  });
});
