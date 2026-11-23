/**
 * #1065: per-IP and per-key WebSocket limits, against a real HTTP server and
 * real `ws` clients, so the asynchronous handshake is the real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'http';
import { once } from 'events';
import type { AddressInfo } from 'net';
import { WebSocket, type WebSocketServer } from 'ws';

process.env.NODE_ENV = 'test';

const testConfig = vi.hoisted(() => ({
  config: {
    trustProxy: 1 as boolean | number | string[],
    websocket: {
      authRequired: true,
      maxSubscriptionsPerConnection: 3,
      maxConnectionsPerKey: 10,
      maxConnectionsPerIp: 50,
    },
    soroban: { rpcUrls: ['https://example.com'] },
    redis: { url: '', statusTtlSeconds: 30, quoteTtlSeconds: 60, enabled: false },
    logLevel: 'silent',
    logging: { serviceName: 'test', version: '0.0.0', environment: 'test', sensitiveFields: [], bodyTruncateLength: 200 },
  },
}));

vi.mock('../config', () => testConfig);
vi.mock('../services/soroban', () => ({
  sorobanService: { getTransactionStatus: vi.fn().mockResolvedValue({ status: 'pending' }) },
}));
vi.mock('../services/explorer', () => ({ explorerService: { txUrl: vi.fn(() => 'https://x') } }));
vi.mock('../middleware/rbacAuth', () => ({
  resolveRecord: vi.fn((token: string) => (token.startsWith('key-') ? { revoked: false, expiresAt: null } : null)),
}));
vi.mock('../services/cache', () => ({
  buildCacheKey: vi.fn(() => 'k'),
  CACHE_TTL: { status: 30 },
  getOrCompute: vi.fn(async (_k: string, _t: number, compute: () => unknown) => compute()),
}));

import { createWebSocketServer, handleUpgrade, clientIpOf } from '../services/websocket';

let server: Server;
let wss: WebSocketServer;
let url: string;
const open: WebSocket[] = [];

/** Resolves to the HTTP status of the upgrade: 101 on success. */
function connect(token: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, token, { headers });
    open.push(ws);
    ws.once('upgrade', () => resolve(101));
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.once('error', () => resolve(0));
  });
}

beforeEach(async () => {
  testConfig.config.trustProxy = 1;
  testConfig.config.websocket.maxConnectionsPerKey = 10;
  testConfig.config.websocket.maxConnectionsPerIp = 50;
  wss = createWebSocketServer();
  server = createServer();
  server.on('upgrade', (req, socket, head) => handleUpgrade(wss, req, socket as never, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  wss.close();
  server.close();
  await once(server, 'close');
});

describe('WebSocket connection limits (#1065)', () => {
  it('20 concurrent upgrades with one key yield exactly 10 connections', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => connect('key-parallel')));
    expect(results.filter((s) => s === 101)).toHaveLength(10);
    expect(results.filter((s) => s === 429)).toHaveLength(10);
  });

  it('with trustProxy=1, the per-IP limit is keyed on X-Forwarded-For, not the proxy', async () => {
    testConfig.config.websocket.maxConnectionsPerIp = 2;
    const fromClient = { 'X-Forwarded-For': '1.2.3.4' };

    expect(await connect('key-a', fromClient)).toBe(101);
    expect(await connect('key-b', fromClient)).toBe(101);
    expect(await connect('key-c', fromClient)).toBe(429);
    // Same socket address (the "load balancer"), different client: own budget.
    expect(await connect('key-d', { 'X-Forwarded-For': '5.6.7.8' })).toBe(101);
  });

  it('a closed connection gives its slot back', async () => {
    testConfig.config.websocket.maxConnectionsPerKey = 1;
    expect(await connect('key-reuse')).toBe(101);
    expect(await connect('key-reuse')).toBe(429);

    const first = open[0]!;
    first.close();
    await once(first, 'close');
    // The server's close handler runs on its side of the socket; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(await connect('key-reuse')).toBe(101);
  });

  it('a failed handshake does not leak its slot', async () => {
    testConfig.config.websocket.maxConnectionsPerKey = 1;
    // A bare upgrade request without the WebSocket key header: ws rejects the
    // handshake after the slot was taken.
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        port,
        host: '127.0.0.1',
        path: '/ws',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'key-leak' },
      });
      req.on('response', (res: IncomingMessage) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', () => resolve());
      req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await connect('key-leak')).toBe(101);
  });
});

describe('clientIpOf (#1065)', () => {
  const req = (remoteAddress: string, xff?: string) =>
    ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as unknown as IncomingMessage;

  it('ignores X-Forwarded-For when no proxy is trusted', () => {
    testConfig.config.trustProxy = false;
    expect(clientIpOf(req('10.0.0.1', '1.2.3.4'))).toBe('10.0.0.1');
  });

  it('takes one hop from X-Forwarded-For with trustProxy=1', () => {
    testConfig.config.trustProxy = 1;
    expect(clientIpOf(req('10.0.0.1', '9.9.9.9, 1.2.3.4'))).toBe('1.2.3.4');
  });

  it('honours a trusted subnet list like Express does', () => {
    testConfig.config.trustProxy = ['10.0.0.0/8'];
    expect(clientIpOf(req('10.0.0.1', '1.2.3.4'))).toBe('1.2.3.4');
    expect(clientIpOf(req('8.8.8.8', '1.2.3.4'))).toBe('8.8.8.8');
  });
});
