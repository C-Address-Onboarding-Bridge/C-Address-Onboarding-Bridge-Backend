import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';

const originalEnv = {
  nodeEnv: process.env.NODE_ENV,
};

process.env.NODE_ENV = 'test';

let server: import('http').Server | undefined;
let wss: import('ws').WebSocketServer | undefined;
let port: number;
let originalAuthRequired: boolean | undefined;

beforeAll(async () => {
  const { config } = await import('../config');
  originalAuthRequired = config.websocket.authRequired;
  config.websocket.authRequired = false;

  const { createApiServer } = await import('../services/httpServer');
  const app = express();
  app.get('/health/live', (_req, res) => res.status(200).json({ alive: true }));
  const apiServer = createApiServer(app);
  server = apiServer.server;
  wss = apiServer.wss;

  await new Promise<void>((resolve, reject) => {
    apiServer.server.once('error', reject);
    apiServer.server.listen(0, '127.0.0.1', resolve);
  });

  port = (apiServer.server.address() as AddressInfo).port;
});

afterAll(async () => {
  const wsServer = wss;
  if (wsServer) {
    const { closeWebSocketServer } = await import('../services/websocket');
    await closeWebSocketServer(wsServer);
  }
  const httpServer = server;
  if (httpServer?.listening) {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  if (originalEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv.nodeEnv;
  const { config } = await import('../config');
  if (originalAuthRequired !== undefined) config.websocket.authRequired = originalAuthRequired;
});

describe('HTTP and WebSocket server wiring', () => {
  it('serves HTTP requests and accepts WebSocket upgrades at /ws', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(response.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const message = await new Promise<{ type: string }>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    expect(message.type).toBe('connected');
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  });

  it('rejects WebSocket upgrades on paths other than /ws', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/not-ws`);
    const error = await new Promise<Error>((resolve) => ws.once('error', resolve));
    expect(error.message).toContain('404');
  });
});
